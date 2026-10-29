// crew/ is a vendored release of the agentmash crew, written only by
// tools/sync-crew.mjs. The CLI's `team` command, the server's one-click
// installer and the /agents pages all read it, and the promise that a team is
// the same bytes whichever way it was installed only holds while crew/ is
// exactly the tagged release. So these tests re-hash it against the lock the
// sync wrote: a hand edit, a stray file or a half-finished sync fails here,
// not in someone's repository. The fix is never to edit crew/: change it
// upstream and tag (or, for an agent's model, change tools/crew-models.json),
// and run `node tools/sync-crew.mjs --from <checkout>`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const CREW = path.join(REPO_ROOT, 'crew');
const LOCK = 'crew.lock.json';
const RESYNC = 'crew/ is written by tools/sync-crew.mjs, never by hand; re-run it from a clean checkout of the tag';

const lock = JSON.parse(fs.readFileSync(path.join(CREW, LOCK), 'utf8'));
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(CREW, name), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('crew/ holds exactly the files its lock lists, byte for byte', () => {
  const onDisk = fs
    .readdirSync(CREW, { withFileTypes: true })
    .filter((entry) => entry.name !== LOCK)
    .map((entry) => {
      // lstat, not stat: a symlink would hash whatever it points at today.
      const regular = fs.lstatSync(path.join(CREW, entry.name)).isFile();
      assert.ok(regular, `crew/${entry.name} is not a regular file; ${RESYNC}`);
      return entry.name;
    })
    .sort();
  const listed = Object.keys(lock.files).sort();
  assert.deepEqual(onDisk, listed, `the files in crew/ are not the ones crew/${LOCK} lists; ${RESYNC}`);
  for (const name of onDisk) {
    const actual = sha256(fs.readFileSync(path.join(CREW, name)));
    assert.equal(actual, lock.files[name], `crew/${name} does not match crew/${LOCK}; ${RESYNC}`);
  }
});

test('the lock, the bundle and the catalog name one release', () => {
  assert.deepEqual(Object.keys(lock), ['version', 'tag', 'repo', 'commit', 'files']);
  assert.equal(lock.tag, `v${lock.version}`);
  assert.match(lock.commit, /^[0-9a-f]{40}$/);
  const bundle = readJson('bundle.json');
  const catalog = readJson('catalog.json');
  assert.equal(bundle.meta.version, lock.version);
  assert.equal(catalog.version, lock.version);
  assert.equal(bundle.meta.url, `https://github.com/${lock.repo}`);
});

test('the crew command the README shows is the agentmash CLI\'s, never a github: spec', () => {
  // The pages show `npx agentmash crew add` (landing/scripts/crew-pages.mjs)
  // and check their own text; the README is written by hand, so it is held
  // here. A `npx github:` form would spell the crew maintainer's handle and
  // run whatever that repository holds that day, past crew/ and its lock.
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'README.md'), 'utf8');
  assert.match(readme, /npx agentmash crew add "agentmash crew" --agents [a-z,]+/, 'README.md shows npx agentmash crew add with the example team');
  assert.doesNotMatch(readme, /npx github:/, 'README.md shows no npx github: command');
});

test('the vendored installer loads the vendored bundle from its own directory', async () => {
  // loadBundle runs verifyBundle, which checks the sha256 of every file the
  // bundle installs; importing install.mjs proves its ./team-plan.mjs import
  // still resolves beside it, which is how the CLI package loads it too.
  const { loadBundle } = await import(pathToFileURL(path.join(CREW, 'install.mjs')).href);
  const bundle = loadBundle(path.join(CREW, 'bundle.json'));
  // The pages and the server's /agents/:short names come from the catalog,
  // the installers from the bundle. A name in only one of them is a page
  // whose "add to a team" fails.
  const catalog = readJson('catalog.json');
  assert.equal(catalog.conductor, bundle.meta.conductor);
  assert.deepEqual(
    catalog.agents.map((agent) => agent.name).sort(),
    bundle.agents.map((agent) => agent.name).sort()
  );
});

test('crew/team-plan.d.mts is the last synced copy of tools/crew-team-plan.d.mts', () => {
  // The declarations are the one file in crew/ that lives in this repo. An
  // edit to the source that was never synced would leave the server compiling
  // against types nobody reviewed with the lock. The sync writes it with LF,
  // whatever a core.autocrlf checkout made of the source.
  const source = fs.readFileSync(path.join(REPO_ROOT, 'tools', 'crew-team-plan.d.mts'), 'utf8').replace(/\r\n/g, '\n');
  const copy = fs.readFileSync(path.join(CREW, 'team-plan.d.mts'), 'utf8');
  assert.equal(copy, source, `tools/crew-team-plan.d.mts changed after the last sync; ${RESYNC}`);
});

test('every crew agent runs on the model tools/crew-models.json gives it', async () => {
  // The sync sets each agent's model over the release's (tools/crew-models.mjs).
  // Setting them again over crew/ as it is must change nothing: an edit to
  // tools/crew-models.json that was never synced, or a model line edited by
  // hand, comes back different here.
  const { applyModels, readModels } = await import(pathToFileURL(path.join(REPO_ROOT, 'tools', 'crew-models.mjs')).href);
  const models = readModels();
  const bundleBytes = fs.readFileSync(path.join(CREW, 'bundle.json'));
  const catalogBytes = fs.readFileSync(path.join(CREW, 'catalog.json'));
  const again = applyModels(bundleBytes, catalogBytes, models);
  assert.ok(again.bundle.equals(bundleBytes), `crew/bundle.json does not carry the models tools/crew-models.json sets; ${RESYNC}`);
  assert.ok(again.catalog.equals(catalogBytes), `crew/catalog.json does not carry the models tools/crew-models.json sets; ${RESYNC}`);

  // the file an install writes says it in its frontmatter, the catalog the pages read says the same
  const bundle = readJson('bundle.json');
  const catalog = readJson('catalog.json');
  for (const agent of bundle.agents) {
    const head = agent.content.split('\n---\n')[0];
    assert.match(head, new RegExp(`^model: ${models[agent.name].model}$`, 'm'), `${agent.path} runs on the wrong model`);
    assert.equal(catalog.agents.find((a) => a.name === agent.name).model, models[agent.name].model, agent.name);
  }

  // and crew/README.md explains each one
  const readme = fs.readFileSync(path.join(CREW, 'README.md'), 'utf8');
  for (const [name, { model, why }] of Object.entries(models)) {
    assert.ok(readme.includes(`| \`${name}\` | ${model} | `), `crew/README.md has no row for ${name} on ${model}; ${RESYNC}`);
    assert.ok(readme.includes(` | ${why} |`), `crew/README.md does not say why ${name} runs on ${model}; ${RESYNC}`);
  }
});

test('no crew agent is put on opus or fable', async () => {
  // Installing a team should not make anyone's plan burn faster: an agent
  // follows the session that called it (inherit) or runs on a cheaper model.
  // Opus or fable is for the person to choose, in their own copy of the file.
  const { MODEL, readModels } = await import(pathToFileURL(path.join(REPO_ROOT, 'tools', 'crew-models.mjs')).href);
  for (const [name, { model }] of Object.entries(readModels())) {
    assert.match(model, MODEL, `${name}: ${model} is not a model Claude Code takes`);
    assert.doesNotMatch(model, /^(?:opus|fable|claude-opus|claude-fable|claude-mythos)/, `${name} is put on ${model}`);
  }
});

test('crew/README.md says in words what its models table says', async () => {
  // The sentence is made from the table's rows, not written by hand, so it
  // stays true whichever agent tools/crew-models.json moves.
  const { modelsSummary } = await import(pathToFileURL(path.join(REPO_ROOT, 'tools', 'crew-models.mjs')).href);
  const readme = fs.readFileSync(path.join(CREW, 'README.md'), 'utf8');
  const rows = [...readme.matchAll(/^\| `([a-z0-9-]+)` \| (\S+) \| (\S+) \| (.+) \|$/gm)].map(
    ([, name, model, release, why]) => ({ name, model, release, why })
  );
  assert.equal(rows.length, readJson('bundle.json').agents.length, 'crew/README.md should have one models row per agent');
  assert.ok(readme.includes(modelsSummary(rows)), `crew/README.md's models paragraph is not the one its table makes; ${RESYNC}`);
});

test('the models summary follows the rows: names, counts and who can cost more', async () => {
  const { modelsSummary } = await import(pathToFileURL(path.join(REPO_ROOT, 'tools', 'crew-models.mjs')).href);
  const row = (name, release, model) => ({ name, release, model, why: 'x' });
  const now = [
    row('scout', 'sonnet', 'haiku'),
    row('lingo', 'sonnet', 'sonnet'),
    row('quill', 'sonnet', 'sonnet'),
    row('gavel', 'opus', 'inherit'),
    row('flex', 'inherit', 'inherit'),
  ];
  assert.equal(
    modelsSummary(now),
    '`scout` runs on haiku. `lingo` and `quill` run on sonnet. The other 2 say `inherit`: the model of the session that called them. ' +
      'None is put on opus or fable. Against the release, an agent costs more per token only here: ' +
      '`gavel`, on opus in the release, now follows the session and costs more when it runs on fable.'
  );

  // lingo flipped to inherit: no longer on sonnet, and now dearer on an opus session
  const flipped = now.map((r) => (r.name === 'lingo' ? { ...r, model: 'inherit' } : r));
  const said = modelsSummary(flipped);
  assert.match(said, /^`scout` runs on haiku\. `quill` runs on sonnet\. The other 3 say `inherit`/);
  assert.match(said, /`lingo`, on sonnet in the release, now follows the session and costs more when it runs on opus or fable/);

  // pinned where the release followed the session, or moved up
  const pinned = [row('inspo', 'inherit', 'haiku'), row('quill', 'inherit', 'sonnet'), row('bump', 'haiku', 'sonnet')];
  const pinnedSaid = modelsSummary(pinned);
  assert.doesNotMatch(pinnedSaid, /`inspo`[^.;]*costs more/, 'haiku is the cheapest, so pinning to it never costs more');
  assert.match(pinnedSaid, /`quill` followed the session in the release and costs more on sonnet when the session runs on haiku/);
  assert.match(pinnedSaid, /`bump` moves from haiku up to sonnet/);

  // nothing dearer at all
  assert.match(modelsSummary([row('a', 'opus', 'sonnet'), row('b', 'fable', 'inherit')]), /no agent costs more per token, whatever the session runs on\.$/);
  // an opus pin drops the "none on opus" sentence
  assert.doesNotMatch(modelsSummary([row('a', 'opus', 'opus')]), /None is put on opus/);
});
