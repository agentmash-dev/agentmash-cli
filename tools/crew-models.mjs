/**
 * The model each crew agent runs on, as agentmash sets it over the release's
 * own choice. tools/crew-models.json holds one entry per agent,
 * { "<agent>": { "model": "haiku", "why": "..." } }, and tools/sync-crew.mjs
 * writes it into crew/ with applyModels: the `model:` line of each agent file
 * in bundle.json (and the sha256 the bundle keeps for that file) and the
 * `model` the catalog gives the /agents pages. Nothing else in a release
 * changes. The `why` is for the table in crew/README.md.
 *
 * cli/test/crew-lock.test.mjs runs applyModels over crew/ as it is and expects
 * the same bytes back, so an edit to tools/crew-models.json that was never
 * synced fails the tests.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODELS_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'crew-models.json');

/**
 * What a Claude Code subagent's `model:` may say: an alias, `inherit` (the
 * model of the session that called it) or a full model id.
 */
export const MODEL = /^(?:sonnet|opus|haiku|fable|inherit|claude-[a-z0-9-]+)$/;

/** No `model:` line at all means the session's model. */
const DEFAULT_MODEL = 'inherit';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** How the release writes its JSON; checked before the overlay writes it back the same way. */
const serialize = (value) => JSON.stringify(value, null, 2) + '\n';

/** Reads and checks tools/crew-models.json (or `file`); throws saying what is wrong. */
export function readModels(file = MODELS_SOURCE) {
  const where = path.basename(file);
  let models;
  try {
    models = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${where} is not readable JSON: ${err.message}`);
  }
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    throw new Error(`${where} must be an object keyed by agent name`);
  }
  for (const [name, entry] of Object.entries(models)) {
    if (typeof entry?.model !== 'string' || !MODEL.test(entry.model)) {
      const said = JSON.stringify(entry?.model);
      throw new Error(`${where}: ${name} needs a model (sonnet, opus, haiku, fable, inherit or a full model id), not ${said}`);
    }
    // it becomes a cell of a markdown table
    if (typeof entry.why !== 'string' || !entry.why.trim() || /[|\r\n]/.test(entry.why)) {
      throw new Error(`${where}: ${name} needs a one-line why, with no "|" in it`);
    }
  }
  return models;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

function parseRelease(bytes, name) {
  const text = bytes.toString('utf8');
  const value = JSON.parse(text);
  if (serialize(value) !== text) {
    throw new Error(`${name} is not laid out the way JSON.stringify(value, null, 2) writes it, so setting the models would rewrite more than the model lines`);
  }
  return value;
}

/**
 * Sets every agent's model in a release's bundle.json and catalog.json.
 * Returns the new bytes of both and one row per agent, in the bundle's order:
 * { name, release, model, why }, where `release` is the model the release
 * itself gave. Throws if an agent has no entry, an entry names no agent, or
 * the release's file and catalog disagree about an agent's model.
 */
export function applyModels(bundleBytes, catalogBytes, models) {
  const bundle = parseRelease(bundleBytes, 'bundle.json');
  const catalog = parseRelease(catalogBytes, 'catalog.json');
  const names = bundle.agents.map((agent) => agent.name);
  const missing = names.filter((name) => !Object.hasOwn(models, name));
  const unknown = Object.keys(models).filter((name) => !names.includes(name));
  if (missing.length > 0) throw new Error(`tools/crew-models.json has no model for ${missing.join(', ')}`);
  if (unknown.length > 0) throw new Error(`tools/crew-models.json names ${unknown.join(', ')}, who are not in this crew release`);

  const rows = [];
  for (const agent of bundle.agents) {
    const { model, why } = models[agent.name];
    const head = FRONTMATTER.exec(agent.content);
    if (!head) throw new Error(`${agent.path} in bundle.json has no frontmatter`);
    const lines = head[1].split('\n');
    const at = lines.flatMap((line, i) => (/^model:/.test(line) ? [i] : []));
    if (at.length > 1) throw new Error(`${agent.path} in bundle.json has ${at.length} model lines`);
    const release = at.length === 1 ? lines[at[0]].slice('model:'.length).trim() : DEFAULT_MODEL;
    const entry = catalog.agents.find((a) => a.name === agent.name);
    if (!entry) throw new Error(`${agent.name} is in bundle.json but not in catalog.json`);
    if ((entry.model ?? DEFAULT_MODEL) !== release) {
      throw new Error(`catalog.json gives ${agent.name} the model ${entry.model}, but its file says ${release}`);
    }
    if (at.length === 1) lines[at[0]] = `model: ${model}`;
    else lines.push(`model: ${model}`);
    agent.content = `---\n${lines.join('\n')}\n---\n${agent.content.slice(head[0].length)}`;
    agent.sha256 = sha256(agent.content);
    entry.model = model;
    rows.push({ name: agent.name, release, model, why });
  }
  return { bundle: Buffer.from(serialize(bundle), 'utf8'), catalog: Buffer.from(serialize(catalog), 'utf8'), rows };
}

/** The model families, cheapest per token first. */
const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'];

/** Where a model sits in FAMILIES: an alias, or the family a full id names; -1 when it names none. */
const rank = (model) => FAMILIES.findIndex((family) => model === family || model.includes(`-${family}`));

const code = (name) => `\`${name}\``;

/** "a", "a and b", "a, b and c" (or "or"). */
function list(items, last = 'and') {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${last} ${items.at(-1)}`;
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) groups.set(row[key], [...(groups.get(row[key]) ?? []), row.name]);
  return groups;
}

/**
 * The models section of crew/README.md in words, made from the rows applyModels
 * returns, so it says what the table says however tools/crew-models.json
 * changes: who runs on which model, who follows the session, and which agents
 * can cost more per token than the release had them, and on which sessions.
 */
export function modelsSummary(rows) {
  const sentences = [];
  const byModel = groupBy(rows, 'model');
  const pinned = [...byModel.keys()].filter((model) => model !== 'inherit');
  pinned.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const model of pinned) {
    const names = byModel.get(model);
    sentences.push(`${list(names.map(code))} ${names.length === 1 ? 'runs' : 'run'} on ${model}.`);
  }
  const following = byModel.get('inherit') ?? [];
  if (following.length === 1 && pinned.length > 0) {
    sentences.push(`${code(following[0])} says \`inherit\`: the model of the session that called it.`);
  } else if (following.length > 0) {
    const who = pinned.length === 0 ? `All ${following.length}` : `The other ${following.length}`;
    sentences.push(`${who} say \`inherit\`: the model of the session that called them.`);
  }
  if (!rows.some((row) => row.model !== 'inherit' && (rank(row.model) < 0 || rank(row.model) >= rank('opus')))) {
    sentences.push('None is put on opus or fable.');
  }

  // Against the release: an agent pinned above its old model always costs more;
  // one that now follows the session costs more on a session above its old
  // model; one pinned where it followed the session costs more on a session
  // below its new model. A model with no family we know may cost more.
  const dearer = [];
  for (const row of rows) {
    if (row.model === row.release) continue;
    const was = rank(row.release);
    const now = rank(row.model);
    if (row.model === 'inherit') {
      const above = was < 0 ? null : FAMILIES.slice(was + 1);
      if (above?.length === 0) continue;
      dearer.push({ ...row, key: `follow ${row.release}`, when: above ? `when it runs on ${list(above, 'or')}` : 'when it runs on a pricier model' });
    } else if (row.release === 'inherit') {
      const below = now < 0 ? null : FAMILIES.slice(0, now);
      if (below?.length === 0) continue;
      dearer.push({ ...row, key: `pin ${row.model}`, when: below ? `when it runs on ${list(below, 'or')}` : 'when it runs on a cheaper model' });
    } else if (was < 0 || now < 0 || now > was) {
      dearer.push({ ...row, key: `${row.release} ${row.model}`, when: null });
    }
  }
  if (dearer.length === 0) {
    sentences.push('Against the release, no agent costs more per token, whatever the session runs on.');
  } else {
    const parts = [...groupBy(dearer, 'key').values()].map((names) => {
      const { release, model, when } = dearer.find((row) => row.name === names[0]);
      const one = names.length === 1;
      const who = list(names.map(code));
      if (model === 'inherit') return `${who}, on ${release} in the release, now ${one ? 'follows' : 'follow'} the session and ${one ? 'costs' : 'cost'} more ${when}`;
      if (release === 'inherit') return `${who} followed the session in the release and ${one ? 'costs' : 'cost'} more on ${model} ${when.replace('it runs', 'the session runs')}`;
      if (rank(release) < 0 || rank(model) < 0) return `${who} ${one ? 'moves' : 'move'} from ${release} to ${model}, which may cost more`;
      return `${who} ${one ? 'moves' : 'move'} from ${release} up to ${model}`;
    });
    sentences.push(`Against the release, an agent costs more per token only here: ${parts.join('; ')}.`);
  }
  return sentences.join(' ');
}
