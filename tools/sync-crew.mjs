/**
 * Vendors a release of the agentmash crew (github.com/agentmash-dev/agentmash-crew)
 * into crew/: the install bundle, the catalog the /agents pages are built
 * from, and the planner and installer that `npx agentmash team`, the site's
 * one-click pull request and the crew's own CLI all run. One copy of the
 * planner is what makes a team the same bytes whichever way it was installed,
 * so this is the only thing that writes crew/.
 *
 *   node tools/sync-crew.mjs --from <agentmash-crew checkout> [--tag v1.1.0]
 *
 * The checkout has to be clean and exactly at the tag (by default v<version>
 * of its bundle), and every file is compared with the blob git has for that
 * commit, so what lands here is the release and not someone's working tree.
 * Before anything in crew/ changes, the copies are loaded and plan one team.
 * It then writes crew/README.md and crew/crew.lock.json: the tag, the commit
 * and the sha256 of every file. cli/test/crew-lock.test.mjs re-hashes crew/
 * against that lock, so a hand edit fails the tests. Two inputs are this
 * repo's own: crew/team-plan.d.mts is copied from tools/crew-team-plan.d.mts,
 * and the model each agent runs on comes from tools/crew-models.json, set over
 * the release's in bundle.json and catalog.json (tools/crew-models.mjs).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyModels, modelsSummary, readModels } from './crew-models.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CREW = path.join(ROOT, 'crew');
const LOCK = 'crew.lock.json';
const TYPES_SOURCE = path.join(ROOT, 'tools', 'crew-team-plan.d.mts');

/** crew/<name> <- <checkout>/<path>, copied byte for byte. */
const UPSTREAM = [
  { name: 'bundle.json', from: 'dist/bundle.json' },
  { name: 'catalog.json', from: 'catalog.json' },
  { name: 'team-plan.mjs', from: 'lib/team-plan.mjs' },
  { name: 'install.mjs', from: 'lib/install.mjs' },
];

const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const GITHUB = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)$/;

const USAGE = `usage: node tools/sync-crew.mjs --from <agentmash-crew checkout> [--tag v1.1.0]

  --from  a clean checkout of agentmash-crew, HEAD exactly at a release tag
  --tag   the tag it must be at (default: v<version> of its dist/bundle.json)
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { from: null, tag: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--from' || arg === '--tag') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      opts[arg.slice(2)] = argv[++i];
    } else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new UsageError(`unknown or incomplete argument: ${arg}`);
  }
  if (!opts.help && !opts.from) throw new UsageError('--from is required: there is no default checkout');
  if (opts.tag !== null && !TAG.test(opts.tag)) throw new UsageError(`not a release tag: ${opts.tag}`);
  return opts;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Runs git in the checkout; a failure carries git's own words. */
function git(from, args, bytes = false) {
  try {
    return execFileSync('git', ['-C', from, ...args], {
      encoding: bytes ? 'buffer' : 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const said = String(err.stderr ?? '').trim() || err.message;
    throw new Error(`git ${args.join(' ')} failed in ${from}: ${said}`);
  }
}

/**
 * The file as the tagged commit has it. Reading the working tree and then
 * insisting it equals the blob catches what a clean `git status` does not: a
 * line-ending conversion or a filter between the object and the disk. Every
 * sha256 in the bundle is of the committed bytes.
 */
function readReleased(from, commit, rel) {
  const abs = path.join(from, ...rel.split('/'));
  const stat = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`${abs} is missing or not a regular file`);
  const bytes = fs.readFileSync(abs);
  if (!bytes.equals(git(from, ['cat-file', 'blob', `${commit}:${rel}`], true))) {
    const why = 'a line-ending conversion or a git filter?';
    throw new Error(`${abs} differs from ${rel} in commit ${commit.slice(0, 7)} (${why})`);
  }
  return bytes;
}

/** Establishes which release the checkout is, or throws saying why it is not one. */
function identify(from, wantedTag) {
  const top = git(from, ['rev-parse', '--show-toplevel']).trim();
  if (fs.realpathSync(top) !== fs.realpathSync(from)) {
    throw new Error(`${from} is inside the checkout at ${top}; pass the top of the checkout`);
  }
  const dirty = git(from, ['status', '--porcelain']).trimEnd();
  if (dirty) {
    const lines = dirty.split('\n');
    const shown = lines.slice(0, 10).join('\n') + (lines.length > 10 ? '\n…' : '');
    throw new Error(`${from} has uncommitted or untracked files; sync from a clean checkout of a tag:\n${shown}`);
  }
  // describe proves HEAD carries a tag at all; the rev-parse below proves it is
  // the one asked for, even when several tags point at the same commit.
  let described;
  try {
    described = git(from, ['describe', '--tags', '--exact-match']).trim();
  } catch (err) {
    throw new Error(`HEAD of ${from} is not a tagged commit; check out a release tag first (${err.message})`);
  }
  const commit = git(from, ['rev-parse', 'HEAD']).trim();
  const pkg = JSON.parse(readReleased(from, commit, 'package.json').toString('utf8'));
  const bundleBytes = readReleased(from, commit, 'dist/bundle.json');
  const version = JSON.parse(bundleBytes.toString('utf8'))?.meta?.version;
  const tag = wantedTag ?? `v${version}`;
  if (!TAG.test(tag)) {
    throw new Error(`the bundle's meta.version ${JSON.stringify(version)} does not make a release tag`);
  }
  let tagged;
  try {
    tagged = git(from, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]).trim();
  } catch {
    throw new Error(`${from} has no tag ${tag}; git fetch --tags there, or pass --tag`);
  }
  if (tagged !== commit) {
    const head = `${commit.slice(0, 7)} (${described})`;
    throw new Error(`HEAD of ${from} is ${head}, not ${tag} (${tagged.slice(0, 7)}); git -C ${from} checkout ${tag}`);
  }
  if (tag !== `v${version}`) throw new Error(`${tag} holds a bundle for version ${version}, not ${tag.slice(1)}`);
  if (pkg.version !== version) throw new Error(`package.json says ${pkg.version} but dist/bundle.json says ${version}`);
  return { commit, tag, version, name: pkg.name };
}

/**
 * Loads the staged copies the way the CLI and the server will, from their own
 * directory, and plans one team with them: install.mjs must still find
 * ./team-plan.mjs, the bundle must pass verifyBundle (every sha256 in it), and
 * the planner must run on it. The catalog must list the bundle's agents: the
 * pages and the server's /agents/:short routes come from the catalog, the
 * installers from the bundle, and a name in one but not the other would be a
 * page whose "add to a team" fails.
 */
async function check(stage, name) {
  const install = await import(pathToFileURL(path.join(stage, 'install.mjs')).href);
  const plan = await import(pathToFileURL(path.join(stage, 'team-plan.mjs')).href);
  const bundle = install.loadBundle(path.join(stage, 'bundle.json'));
  const catalog = JSON.parse(fs.readFileSync(path.join(stage, 'catalog.json'), 'utf8'));
  if (bundle.meta.name !== name) throw new Error(`the bundle is ${bundle.meta.name}, but the checkout is ${name}`);
  if (catalog.version !== bundle.meta.version) {
    throw new Error(`catalog.json is ${catalog.version}, the bundle is ${bundle.meta.version}`);
  }
  const inBundle = bundle.agents.map((a) => a.name).sort();
  const inCatalog = (catalog.agents ?? []).map((a) => a.name).sort();
  if (inBundle.join() !== inCatalog.join() || catalog.conductor !== bundle.meta.conductor) {
    throw new Error(
      `catalog.json and the bundle list different agents:\n  catalog ${inCatalog.join(' ')}\n  bundle  ${inBundle.join(' ')}`
    );
  }
  const repo = GITHUB.exec(bundle.meta.url)?.[1];
  if (!repo) throw new Error(`the bundle's meta.url ${bundle.meta.url} is not a github.com repository`);

  const op = { type: 'add', name: 'crew sync check', members: [bundle.agents[bundle.agents.length - 1].short] };
  const state = { manifest: null, settingsText: null, onDisk: {} };
  for (const p of plan.statePaths(bundle, null, op)) state.onDisk[p] = null;
  const planned = plan.planChange(bundle, state, op);
  if (planned.writes.length === 0 || planned.deletes.length > 0) {
    throw new Error('the vendored planner did not plan a clean first install on an empty repository');
  }
  return { bundle, repo };
}

function readme({ bundle, repo, tag, commit, license, rows }) {
  const url = `https://github.com/${repo}`;
  const conductor = bundle.agents[0];
  return [
    '# crew',
    '',
    `The [agentmash crew](${url}): ${bundle.agents.length} Claude Code agents, ${conductor.title} the conductor among them, vendored at [${tag}](${url}/tree/${tag}) (commit \`${commit}\`). \`npx agentmash team\`, the one-click pull request on agentmash.dev and the /agents pages all read these files, so a team installed any of those ways is the same bytes, and the same as the crew's own installer writes but for one line in each agent file: the model it runs on (see [models](#models)). The install format is specified upstream in [docs/bundle-format.md](${url}/blob/${tag}/docs/bundle-format.md).`,
    '',
    '| file | where it comes from | what it is for |',
    '| --- | --- | --- |',
    '| `bundle.json` | `dist/bundle.json`, with the models from `tools/crew-models.json` | every file an install writes, the team skill template and the guard hook |',
    '| `catalog.json` | `catalog.json`, with the same models | the /agents pages, and the agent names the server routes accept |',
    '| `team-plan.mjs` | `lib/team-plan.mjs` | the pure planner (`planChange`) the CLI and the server both run |',
    '| `install.mjs` | `lib/install.mjs` | the file-system side the CLI runs (`runTeamOp`, `listTeams`, `loadBundle`) |',
    '| `team-plan.d.mts` | this repo, `tools/crew-team-plan.d.mts` | TypeScript declarations for `team-plan.mjs` |',
    '| `crew.lock.json` | the sync | the tag, the commit and the sha256 of every other file here |',
    '',
    '## Models',
    '',
    `Each agent file has a \`model:\` line, and Claude Code runs the agent on that model. The release picks one per agent; the sync sets agentmash's own over it, from \`tools/crew-models.json\`, in the agent's file in \`bundle.json\` (and the sha256 the bundle keeps for it) and in \`catalog.json\`, which the /agents pages show. Nothing else in the release changes. ${modelsSummary(rows)} The table says why for each.`,
    '',
    "A repository with a team already in it gets these lines from `npx agentmash team update`. An agent file someone changed by hand is kept as it is, as the planner keeps any file changed locally. The crew's own installer writes the release's models; run `npx agentmash team update` after it to put these back.",
    '',
    '| agent | model | in the release | why |',
    '| --- | --- | --- | --- |',
    ...rows.map((row) => `| \`${row.name}\` | ${row.model} | ${row.release} | ${row.why} |`),
    '',
    '## Never edit by hand',
    '',
    'Everything here is written by `tools/sync-crew.mjs`, and `cli/test/crew-lock.test.mjs` re-hashes it against `crew.lock.json`, so a hand edit fails the tests. A change to an agent, the bundle or the planner goes upstream, gets a tag, and comes here by a sync. Two inputs are kept in this repo: the declarations, `tools/crew-team-plan.d.mts`, and the models, `tools/crew-models.json`. Edit either and sync again.',
    '',
    '## Updating',
    '',
    '```bash',
    'git -C ../agentmash-crew fetch --tags',
    'git -C ../agentmash-crew checkout v<new version>',
    'node tools/sync-crew.mjs --from ../agentmash-crew',
    '```',
    '',
    'The script refuses a checkout that has local changes or is not exactly at the tag, and checks every file against the blob in the tagged commit. Review the diff of `crew/`, run the tests, and commit `crew/` with its lock. The CLI package carries its own copy of these files, so people running `npx agentmash` get a new crew version, or new models, with the next CLI release.',
    '',
    '## License',
    '',
    `\`bundle.json\`, \`catalog.json\`, \`team-plan.mjs\` and \`install.mjs\` are copied from [agentmash-crew](${url}) and are under its MIT License:`,
    '',
    ...license.trimEnd().split('\n').map((line) => (line ? `    ${line}` : '')),
    '',
  ].join('\n');
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const from = path.resolve(opts.from);
  if (!fs.statSync(from, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${from} is not a directory`);
  const release = identify(from, opts.tag);

  const files = new Map();
  for (const { name, from: rel } of UPSTREAM) files.set(name, readReleased(from, release.commit, rel));
  // agentmash's models go over the release's; check() below loads the result,
  // so a bundle whose sha256s no longer match its files never lands
  const models = applyModels(files.get('bundle.json'), files.get('catalog.json'), readModels());
  files.set('bundle.json', models.bundle);
  files.set('catalog.json', models.catalog);
  // a checkout with core.autocrlf has it with CRLF; crew/ keeps the LF the lock was made with
  files.set('team-plan.d.mts', Buffer.from(fs.readFileSync(TYPES_SOURCE, 'utf8').replace(/\r\n/g, '\n'), 'utf8'));
  const license = readReleased(from, release.commit, 'LICENSE').toString('utf8');

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-crew-sync-'));
  let checked;
  try {
    for (const [name, bytes] of files) fs.writeFileSync(path.join(stage, name), bytes);
    checked = await check(stage, release.name);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  files.set('README.md', Buffer.from(readme({ ...release, ...checked, license, rows: models.rows })));

  // Anything else in crew/ is either a file an earlier sync wrote and this
  // release no longer has (it is in the old lock, so it goes), or something
  // nobody should have put there (so nothing is written until it is moved).
  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(path.join(CREW, LOCK), 'utf8')).files ?? {};
  } catch {
    /* first sync, or an unreadable lock: every stray file counts as unknown */
  }
  const stale = [];
  for (const entry of fs.existsSync(CREW) ? fs.readdirSync(CREW, { withFileTypes: true }) : []) {
    if (entry.name === LOCK || files.has(entry.name)) continue;
    if (!entry.isFile() || !Object.hasOwn(previous, entry.name)) {
      throw new Error(
        `crew/${entry.name} was not written by this script (it is not in crew/${LOCK}); move it out of crew/ and rerun`
      );
    }
    stale.push(entry.name);
  }

  fs.mkdirSync(CREW, { recursive: true });
  const hashes = {};
  const names = [...files.keys()].sort();
  const width = Math.max(...names.map((n) => n.length));
  console.log(`agentmash-crew ${release.tag} (${release.commit.slice(0, 7)}) from ${from}`);
  for (const name of names) {
    const bytes = files.get(name);
    const target = path.join(CREW, name);
    const before = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (!before?.equals(bytes)) fs.writeFileSync(target, bytes);
    hashes[name] = sha256(bytes);
    const what = before === null ? 'created' : before.equals(bytes) ? 'unchanged' : 'updated';
    console.log(`  crew/${name.padEnd(width)}  ${hashes[name].slice(0, 12)}  ${what}`);
  }
  for (const name of stale) {
    fs.rmSync(path.join(CREW, name));
    console.log(`  crew/${name.padEnd(width)}  removed (not in ${release.tag})`);
  }

  // The key order is the contract's; the sha256s are sorted by file name.
  const lock = {
    version: release.version,
    tag: release.tag,
    repo: checked.repo,
    commit: release.commit,
    files: hashes,
  };
  fs.writeFileSync(path.join(CREW, LOCK), JSON.stringify(lock, null, 2) + '\n');
  console.log(`synced ${names.length} files into crew/ and locked them in crew/${LOCK}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
);
