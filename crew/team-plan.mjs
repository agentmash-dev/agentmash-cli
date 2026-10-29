// Pure planning logic for installing agentmash crew teams into a repository.
//
// Nothing here touches the file system, the process or the network: every function takes plain data (the bundle and
// a snapshot of the repository) and returns plain data. lib/install.mjs performs the side effects.
//
// Other installers (the agentmash CLI, the agentmash.dev web installer) must produce byte-identical files from the
// same bundle, so every ordering, substitution and serialization rule below is part of the documented format
// (docs/bundle-format.md): sort by UTF-16 code units, substitute placeholders in a single pass, serialize JSON as
// JSON.stringify(value, null, 2) + "\n", and never write timestamps.

import { createHash } from 'node:crypto';

export const SETTINGS_PATH = '.claude/settings.json';
export const MANIFEST_SCHEMA = 1;

const BUNDLE_SCHEMA = 1;
const RESERVED_PREFIX = '.claude/agentmash/'; // owned by the agentmash CLI, never ours
const NAME_MAX = 60;
const ROLE_MAX = 60;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PATH_RE = /^[A-Za-z0-9._/-]+$/;
const AGENT_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PLACEHOLDER_RE = /\{\{([a-z_]+)\}\}/g;
const PLACEHOLDERS = new Set([
  'team_name', 'team_slug', 'skill_name', 'members_inline', 'roster_table', 'missing_inline', 'add_command',
]);

// Russian and Kazakh Cyrillic to Latin. Hard and soft signs vanish instead of becoming a separator.
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  ә: 'a', ғ: 'g', қ: 'q', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h', і: 'i',
};

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

const toJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const quote = (value) => JSON.stringify(value);

// Single pass: substituted values are never scanned again, so a team named "{{team_slug}}" stays literal.
// Unknown placeholders are left as they are (verifyBundle rejects templates that contain any).
function fill(text, values) {
  return text.replace(PLACEHOLDER_RE, (match, key) => (key in values ? values[key] : match));
}

function sortedObject(record) {
  const out = {};
  for (const key of Object.keys(record).sort(compare)) out[key] = record[key];
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Paths

/**
 * Returns why `path` is not an acceptable install target, or null when it is.
 *
 * Paths are plain ASCII so that letter case is the only way two spellings can name one file. The protected paths are
 * compared ignoring ASCII case, because on a case-insensitive file system (macOS, Windows) `.claude/Settings.json`
 * is `.claude/settings.json`.
 */
export function pathProblem(path) {
  if (typeof path !== 'string' || path === '') return 'must be a non-empty string';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return 'must be relative';
  if (path.includes('\\')) return 'must not contain a backslash';
  if (path.includes('..')) return 'must not contain ".."';
  if (!path.startsWith('.claude/')) return 'must start with ".claude/"';
  if (!PATH_RE.test(path)) return 'must use only ASCII letters, digits, ".", "_", "-" and "/"';
  if (path.split('/').some((segment) => segment === '' || segment === '.')) return 'must not contain empty or "." segments';
  const folded = path.toLowerCase();
  if (folded.startsWith(RESERVED_PREFIX) || `${folded}/` === RESERVED_PREFIX) {
    return `must not be inside ${RESERVED_PREFIX} (owned by the agentmash CLI), in any letter case`;
  }
  if (folded === SETTINGS_PATH) return 'must not be the settings file, in any letter case (it is merged, never overwritten)';
  return null;
}

export function assertSafePath(path, what = 'path') {
  const problem = pathProblem(path);
  if (problem) throw new Error(`${what} ${quote(path)} ${problem}`);
  return path;
}

// ---------------------------------------------------------------------------------------------------------------
// Bundle

/**
 * Checks the bundle's shape, every sha256 and every path. Returns the bundle; throws on the first problem.
 * The agents array order is the canonical order, and the conductor must come first.
 */
export function verifyBundle(bundle) {
  const fail = (message) => {
    throw new Error(`invalid bundle: ${message}`);
  };
  const requireString = (value, where) => {
    if (typeof value !== 'string' || value === '') fail(`${where} must be a non-empty string`);
  };
  const seenPaths = new Set();
  const claimPath = (path, where) => {
    const problem = pathProblem(path);
    if (problem) fail(`${where} ${quote(path)} ${problem}`);
    if (seenPaths.has(path)) fail(`${where} ${quote(path)} is used twice`);
    seenPaths.add(path);
  };
  const verifyFile = (file, where) => {
    if (!isObject(file)) fail(`${where} must be an object`);
    claimPath(file.path, `${where}.path`);
    if (typeof file.content !== 'string') fail(`${where}.content must be a string`);
    if (typeof file.sha256 !== 'string' || !SHA256_RE.test(file.sha256)) fail(`${where}.sha256 must be 64 hex chars`);
    if (sha256Hex(file.content) !== file.sha256) fail(`${where} (${file.path}): sha256 does not match the content`);
  };

  if (!isObject(bundle)) fail('not a JSON object');
  if (bundle.schema !== BUNDLE_SCHEMA) fail(`schema ${quote(bundle.schema)} is not supported (expected ${BUNDLE_SCHEMA})`);

  const { meta, agents, shared, templates } = bundle;
  if (!isObject(meta)) fail('meta must be an object');
  for (const key of ['name', 'version', 'url', 'conductor', 'addCommand', 'manifestPath']) {
    requireString(meta[key], `meta.${key}`);
  }
  if (!meta.addCommand.includes('<team>')) fail('meta.addCommand must contain <team>');
  claimPath(meta.manifestPath, 'meta.manifestPath');

  const { hook } = meta;
  if (!isObject(hook)) fail('meta.hook must be an object');
  for (const key of ['event', 'matcher', 'command', 'marker']) requireString(hook[key], `meta.hook.${key}`);
  if (!Number.isInteger(hook.timeout) || hook.timeout <= 0) fail('meta.hook.timeout must be a positive integer');
  // Without the marker in the command we could never recognise our own hook and would add it on every run.
  if (!hook.command.includes(hook.marker)) fail('meta.hook.command must contain meta.hook.marker');

  if (!Array.isArray(agents) || agents.length === 0) fail('agents must be a non-empty array');
  const names = new Set();
  const shorts = new Set();
  agents.forEach((agent, i) => {
    const where = `agents[${i}]`;
    if (!isObject(agent)) fail(`${where} must be an object`);
    if (typeof agent.name !== 'string' || !AGENT_NAME_RE.test(agent.name)) fail(`${where}.name ${quote(agent.name)} is not a valid agent name`);
    if (agent.short !== agent.name.split('-')[0]) fail(`${where}.short must be the part of the name before the first "-"`);
    if (names.has(agent.name) || shorts.has(agent.short)) fail(`${where}: agent ${agent.name} is not unique`);
    names.add(agent.name);
    shorts.add(agent.short);
    requireString(agent.title, `${where}.title`);
    requireString(agent.group, `${where}.group`);
    requireString(agent.role, `${where}.role`);
    // The role lands in a markdown table cell, so it must stay one short line without pipes.
    if (Array.from(agent.role).length > ROLE_MAX || /[\n\r|]/.test(agent.role)) {
      fail(`${where}.role must be one line of at most ${ROLE_MAX} characters without "|"`);
    }
    verifyFile(agent, where);
  });
  if (agents[0].name !== meta.conductor) fail(`meta.conductor ${quote(meta.conductor)} must be the first agent`);

  if (!Array.isArray(shared)) fail('shared must be an array');
  shared.forEach((file, i) => verifyFile(file, `shared[${i}]`));

  const teamSkill = isObject(templates) ? templates.teamSkill : undefined;
  if (!isObject(teamSkill)) fail('templates.teamSkill must be an object');
  requireString(teamSkill.pathPattern, 'templates.teamSkill.pathPattern');
  if (typeof teamSkill.content !== 'string') fail('templates.teamSkill.content must be a string');
  if (!teamSkill.pathPattern.includes('{{team_slug}}')) fail('templates.teamSkill.pathPattern must contain {{team_slug}}');
  for (const [, key] of teamSkill.pathPattern.matchAll(PLACEHOLDER_RE)) {
    if (key !== 'team_slug') fail(`templates.teamSkill.pathPattern may only use {{team_slug}}, found {{${key}}}`);
  }
  const samplePath = fill(teamSkill.pathPattern, { team_slug: 'sample' });
  const problem = pathProblem(samplePath);
  if (problem) fail(`templates.teamSkill.pathPattern renders to ${quote(samplePath)}, which ${problem}`);
  for (const [, key] of teamSkill.content.matchAll(PLACEHOLDER_RE)) {
    if (!PLACEHOLDERS.has(key)) fail(`templates.teamSkill.content uses unknown placeholder {{${key}}}`);
  }
  return bundle;
}

// ---------------------------------------------------------------------------------------------------------------
// Team names, slugs and members

/** Trims and validates a display name such as "agentmash crew". Length is counted in Unicode code points. */
export function validateTeamName(name) {
  if (typeof name !== 'string') throw new Error('team name must be a string');
  const trimmed = name.trim();
  const length = Array.from(trimmed).length;
  if (length === 0) throw new Error('team name is empty');
  if (length > NAME_MAX) throw new Error(`team name is ${length} characters long; the limit is ${NAME_MAX}`);
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(trimmed)) {
    throw new Error('team name must not contain line breaks or control characters');
  }
  // The name is substituted into a double-quoted YAML string in the team skill's frontmatter, and into shell commands
  // inside double quotes (the team skill's add command, the printed commit command), where $, ` and ! still expand.
  if (/["\\$`!]/.test(trimmed)) {
    throw new Error('team name must not contain double quotes, backslashes, "$", "`" or "!" (it goes into YAML and shell commands)');
  }
  return trimmed;
}

export function validateSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new Error(`invalid slug ${quote(slug)}: use 1-40 characters from a-z, 0-9 and "-", starting with a letter or digit`);
  }
  return slug;
}

/** "Команда 123" -> "komanda-123". Throws when nothing usable is left (e.g. a name written only in CJK). */
export function slugify(name) {
  const latin = Array.from(String(name).toLowerCase(), (char) => TRANSLIT[char] ?? char).join('');
  const slug = latin
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  if (!SLUG_RE.test(slug)) throw new Error(`cannot derive a slug from ${quote(name)}; pass one with --slug, e.g. --slug my-team`);
  return slug;
}

/** Filters `names` to known agents, deduplicated, in the bundle's canonical order. */
function canonical(bundle, names) {
  const wanted = new Set(names);
  return bundle.agents.map((agent) => agent.name).filter((name) => wanted.has(name));
}

/** Resolves CLI tokens (short or full names, any case, or "all") to full agent names in canonical order. */
function lookupAgents(bundle, tokens) {
  const index = new Map();
  for (const agent of bundle.agents) {
    index.set(agent.name, agent.name);
    index.set(agent.short, agent.name);
  }
  const picked = [];
  const unknown = [];
  for (const raw of tokens) {
    const token = String(raw).trim().toLowerCase();
    if (token === '') continue;
    if (token === 'all') picked.push(...index.values());
    else if (index.has(token)) picked.push(index.get(token));
    else unknown.push(String(raw).trim());
  }
  if (unknown.length > 0) {
    const valid = bundle.agents.map((agent) => agent.short).join(', ');
    throw new Error(`unknown agent${unknown.length > 1 ? 's' : ''} ${unknown.map(quote).join(', ')}; valid names: ${valid} (or all)`);
  }
  return canonical(bundle, picked);
}

/** Like lookupAgents, but the conductor is always included (and, by canonical order, always first). */
export function resolveMembers(bundle, tokens) {
  return canonical(bundle, [bundle.meta.conductor, ...lookupAgents(bundle, tokens)]);
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

export function teamSkillPath(bundle, slug) {
  return assertSafePath(fill(bundle.templates.teamSkill.pathPattern, { team_slug: validateSlug(slug) }), 'team skill path');
}

/** Renders the per-team skill. Same bundle + same team -> byte-identical output. */
export function renderTeamSkill(bundle, team) {
  const name = validateTeamName(team.name);
  const slug = validateSlug(team.slug);
  const byName = new Map(bundle.agents.map((agent) => [agent.name, agent]));
  const unknown = team.members.filter((member) => !byName.has(member));
  if (unknown.length > 0) throw new Error(`team ${quote(name)} lists unknown agents: ${unknown.join(', ')}`);

  const members = canonical(bundle, [bundle.meta.conductor, ...team.members]);
  const missing = bundle.agents.map((agent) => agent.name).filter((member) => !members.includes(member));
  const rows = members.map((member) => {
    const agent = byName.get(member);
    return `| ${agent.title} | \`${agent.name}\` | ${agent.role} |`;
  });
  const values = {
    team_name: name,
    team_slug: slug,
    skill_name: `team-${slug}`,
    members_inline: members.join(', '),
    roster_table: ['| Agent | Name | Role |', '| --- | --- | --- |', ...rows].join('\n'),
    missing_inline: missing.length > 0 ? missing.join(', ') : 'none',
    add_command: bundle.meta.addCommand.split('<team>').join(`"${name}"`),
  };
  return { path: teamSkillPath(bundle, slug), content: fill(bundle.templates.teamSkill.content, values) };
}

// ---------------------------------------------------------------------------------------------------------------
// settings.json

function parseSettings(text) {
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${SETTINGS_PATH} is not valid JSON (${error.message}); comments and trailing commas are not supported, fix the file and rerun`,
    );
  }
  if (!isObject(settings)) throw new Error(`${SETTINGS_PATH} must contain a JSON object`);
  if (settings.hooks !== undefined && !isObject(settings.hooks)) throw new Error(`${SETTINGS_PATH}: "hooks" must be an object`);
  return settings;
}

function hookGroups(settings, event) {
  const groups = settings.hooks?.[event];
  if (groups !== undefined && !Array.isArray(groups)) throw new Error(`${SETTINGS_PATH}: "hooks.${event}" must be an array`);
  return groups;
}

const hasMarker = (value, marker) => JSON.stringify(value).includes(marker);

/**
 * Adds our hook group once. `text` is the current settings.json or null when it does not exist.
 * Returns the new text (the original text, untouched, when nothing changed).
 */
export function mergeSettings(text, hook) {
  const group = { matcher: hook.matcher, hooks: [{ type: 'command', command: hook.command, timeout: hook.timeout }] };
  if (text === null || text === undefined) {
    return { text: toJson({ hooks: { [hook.event]: [group] } }), changed: true, created: true };
  }
  const settings = parseSettings(text);
  const groups = hookGroups(settings, hook.event);
  if (groups?.some((existing) => hasMarker(existing, hook.marker))) return { text, changed: false, created: false };

  settings.hooks ??= {};
  settings.hooks[hook.event] = [...(groups ?? []), group];
  return { text: toJson(settings), changed: true, created: false };
}

/**
 * Removes our hook: every entry of a group's "hooks" array whose JSON mentions `marker`. Someone may have added their
 * own hook to that group, so only the entry goes; the group goes too when nothing but `matcher` and an empty "hooks"
 * array is left. `keptGroups` counts groups that lost our entry but stay because they hold something else. The event
 * and "hooks" keys are dropped if they end up empty. With deleteIfEmpty (we created the file), an empty result means
 * "delete the file" and comes back as text null.
 */
export function unmergeSettings(text, marker, { event = 'PreToolUse', deleteIfEmpty = false } = {}) {
  const unchanged = { text: text ?? null, changed: false, keptGroups: 0 };
  if (text === null || text === undefined) return unchanged;
  const settings = parseSettings(text);
  const groups = hookGroups(settings, event);
  if (groups === undefined) return unchanged;

  const kept = [];
  let changed = false;
  let keptGroups = 0;
  for (const group of groups) {
    const entries = isObject(group) && Array.isArray(group.hooks) ? group.hooks : [];
    const rest = entries.filter((entry) => !hasMarker(entry, marker));
    if (rest.length === entries.length) {
      kept.push(group); // none of our entries in it
      continue;
    }
    changed = true;
    if (rest.length === 0 && Object.keys(group).every((key) => key === 'matcher' || key === 'hooks')) continue;
    kept.push({ ...group, hooks: rest });
    keptGroups += 1;
  }
  if (!changed) return unchanged;

  if (kept.length > 0) settings.hooks[event] = kept;
  else delete settings.hooks[event];
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  if (deleteIfEmpty && Object.keys(settings).length === 0) return { text: null, changed: true, keptGroups };
  return { text: toJson(settings), changed: true, keptGroups };
}

// ---------------------------------------------------------------------------------------------------------------
// Manifest (.claude/agentmash-crew/teams.json)

/**
 * The spelling the bundle uses for `path` when the two are equal ignoring ASCII case, or null when the bundle cannot
 * produce such a path. Team skill paths are matched through the path pattern, for any slug.
 */
function bundleSpelling(bundle, path) {
  const folded = path.toLowerCase();
  const fixed = [bundle.meta.manifestPath, ...bundle.shared.map((file) => file.path), ...bundle.agents.map((agent) => agent.path)];
  const known = fixed.find((candidate) => candidate.toLowerCase() === folded);
  if (known) return known;
  const { pathPattern } = bundle.templates.teamSkill;
  const pattern = pathPattern
    .split('{{team_slug}}')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('([a-z0-9][a-z0-9-]{0,39})');
  const match = new RegExp(`^${pattern}$`, 'i').exec(path);
  if (!match) return null;
  const spelled = fill(pathPattern, { team_slug: match[1].toLowerCase() });
  return spelled.toLowerCase() === folded ? spelled : null;
}

/**
 * Parses and validates a manifest. It is committed to the repository, so it is untrusted: every `files` key gets the
 * bundle path checks, and a key that names a file another way (another letter case of a path the bundle writes, of the
 * manifest itself or of another key) is refused, so a tampered manifest cannot aim a deletion at a file we must keep.
 */
export function parseManifest(text, where, bundle) {
  const fail = (message) => {
    throw new Error(`${where}: ${message}; fix the file and rerun`);
  };
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    fail(`not valid JSON (${error.message})`);
  }
  if (!isObject(manifest)) fail('must contain a JSON object');
  if (manifest.schema !== MANIFEST_SCHEMA) fail(`schema ${quote(manifest.schema)} is not supported (expected ${MANIFEST_SCHEMA})`);
  if (!Array.isArray(manifest.teams)) fail('"teams" must be an array');
  if (!isObject(manifest.files)) fail('"files" must be an object');

  const slugs = new Set();
  const teams = manifest.teams.map((team, i) => {
    if (!isObject(team)) fail(`teams[${i}] must be an object`);
    try {
      validateSlug(team.slug);
      validateTeamName(team.name);
    } catch (error) {
      fail(`teams[${i}]: ${error.message}`);
    }
    if (slugs.has(team.slug)) fail(`slug ${team.slug} is used by two teams`);
    slugs.add(team.slug);
    if (!Array.isArray(team.members) || !team.members.every((m) => typeof m === 'string' && AGENT_NAME_RE.test(m))) {
      fail(`teams[${i}].members must be an array of agent names`);
    }
    return { slug: team.slug, name: team.name.trim(), members: [...team.members] };
  });

  const files = {};
  const folded = new Map();
  for (const [path, sha] of Object.entries(manifest.files)) {
    const problem = pathProblem(path);
    if (problem) fail(`files: ${quote(path)} ${problem}`);
    const spelled = bundleSpelling(bundle, path);
    if (spelled === bundle.meta.manifestPath) fail(`files: ${quote(path)} is the manifest itself`);
    if (spelled !== null && spelled !== path) fail(`files: ${quote(path)} differs only in letter case from ${quote(spelled)}`);
    const twin = folded.get(path.toLowerCase());
    if (twin !== undefined) fail(`files: ${quote(path)} and ${quote(twin)} differ only in letter case`);
    folded.set(path.toLowerCase(), path);
    if (typeof sha !== 'string' || !SHA256_RE.test(sha)) fail(`files: ${quote(path)} needs a 64-char sha256`);
    files[path] = sha;
  }
  return { schema: MANIFEST_SCHEMA, source: manifest.source, createdSettings: manifest.createdSettings === true, teams, files };
}

// ---------------------------------------------------------------------------------------------------------------
// Planning

/**
 * Where `add` lands: an existing team matched by exact name or slug, or a new one. The name is matched first, so a team
 * created with --slug (a name the slug rules cannot turn into a slug, such as "日本") can be extended by name alone.
 */
function addTarget(teams, op) {
  const name = validateTeamName(op.name);
  const byName = teams.find((team) => team.name === name);
  if (byName && op.slug === undefined) return { name, slug: byName.slug, existing: byName };
  const slug = op.slug === undefined ? slugify(name) : validateSlug(op.slug);
  if (byName && byName.slug !== slug) {
    throw new Error(`team ${quote(name)} already exists with slug ${byName.slug}; drop --slug or pass --slug ${byName.slug}`);
  }
  const existing = byName ?? teams.find((team) => team.slug === slug) ?? null;
  return { name, slug: existing ? existing.slug : slug, existing };
}

/** Finds a team by exact name, exact slug, or the slug its name would produce. */
function findTeam(teams, ref) {
  const token = String(ref ?? '').trim();
  let derived = null;
  try {
    derived = slugify(token);
  } catch {
    // a reference with no usable characters can still match an exact name
  }
  return teams.find((team) => team.name === token || team.slug === token) ?? teams.find((team) => team.slug === derived) ?? null;
}

/**
 * Every repository path planChange may need a disk hash for. The installer snapshots exactly these
 * (plus settings.json) before planning.
 */
export function statePaths(bundle, manifest, op) {
  const paths = new Set([bundle.meta.manifestPath, ...bundle.shared.map((f) => f.path), ...bundle.agents.map((a) => a.path)]);
  for (const path of Object.keys(manifest?.files ?? {})) paths.add(path);
  for (const team of manifest?.teams ?? []) paths.add(teamSkillPath(bundle, team.slug));
  if (op.type === 'add') paths.add(teamSkillPath(bundle, addTarget(manifest?.teams ?? [], op).slug));
  return [...paths].sort(compare);
}

/** Brings teams from an older manifest in line with this bundle: known agents only, conductor first, canonical order. */
function normalizeTeams(bundle, teams, warnings) {
  const known = new Set(bundle.agents.map((agent) => agent.name));
  return teams.map((team) => {
    const dropped = team.members.filter((member) => !known.has(member));
    if (dropped.length > 0) warnings.push(`team ${quote(team.name)}: dropping ${dropped.join(', ')} (not in this crew version)`);
    return { ...team, members: canonical(bundle, [bundle.meta.conductor, ...team.members]) };
  });
}

function applyAdd(bundle, teams, op, warnings) {
  const { conductor } = bundle.meta;
  const target = addTarget(teams, op);
  const requested = resolveMembers(bundle, op.members ?? []);
  if (!target.existing) {
    if (requested.length < 2) {
      throw new Error(`a new team needs at least one agent besides ${conductor}, e.g. --agents pipe,flex,probe`);
    }
    const team = { slug: target.slug, name: target.name, members: requested };
    return { teams: [...teams, team], target: team, targetIsNew: true };
  }
  if (target.existing.name !== target.name) {
    warnings.push(`${quote(target.name)} has the same slug as team ${quote(target.existing.name)}; extending that team`);
  }
  const team = { ...target.existing, members: canonical(bundle, [...target.existing.members, ...requested]) };
  return { teams: teams.map((t) => (t === target.existing ? team : t)), target: team };
}

function applyRemove(bundle, teams, op, warnings) {
  const { conductor } = bundle.meta;
  if (teams.length === 0) throw new Error('no agentmash teams are installed in this repository');
  const team = findTeam(teams, op.team);
  if (!team) {
    const installed = teams.map((t) => `${quote(t.name)} (${t.slug})`).join(', ');
    throw new Error(`no team ${quote(String(op.team ?? ''))}; installed: ${installed}`);
  }
  if (op.members === undefined) {
    return { teams: teams.filter((t) => t !== team), target: { ...team, members: null } };
  }

  const names = lookupAgents(bundle, op.members);
  if (names.length === 0) throw new Error('no agents given to remove');
  if (names.includes(conductor)) {
    throw new Error(`${conductor} is the conductor and cannot be removed from a team; remove the team instead: team remove ${quote(team.name)}`);
  }
  const absent = names.filter((name) => !team.members.includes(name));
  if (absent.length > 0) warnings.push(`not in team ${quote(team.name)}: ${absent.join(', ')}`);
  const members = team.members.filter((member) => !names.includes(member));
  if (members.length < 2) {
    throw new Error(`that would leave only ${conductor} in ${quote(team.name)}; remove the team instead: team remove ${quote(team.name)}`);
  }
  const updated = { ...team, members };
  return { teams: teams.map((t) => (t === team ? updated : t)), target: updated };
}

/** Every file the teams need, path -> content. */
function desiredFiles(bundle, teams) {
  const files = new Map();
  if (teams.length === 0) return files;
  for (const file of bundle.shared) files.set(file.path, file.content);
  const used = new Set(teams.flatMap((team) => team.members));
  for (const agent of bundle.agents) if (used.has(agent.name)) files.set(agent.path, agent.content);
  for (const team of teams) {
    const skill = renderTeamSkill(bundle, team);
    files.set(skill.path, skill.content);
  }
  return files;
}

/**
 * Compares what we want on disk with what is there and what we wrote last time (`owned`: path -> sha).
 * Actions: created, updated, overwritten (--force), unchanged, kept (changed locally), deleted, left (changed locally,
 * no longer needed, so no longer tracked either).
 */
function reconcile(desired, owned, onDisk, force, warnings) {
  const diskSha = (path) => {
    if (!(path in onDisk)) throw new Error(`internal error: the repository snapshot has no entry for ${path}`);
    return onDisk[path];
  };
  const writes = [];
  const deletes = [];
  const changes = [];
  const tracked = {};
  const foreign = [];

  for (const path of [...desired.keys()].sort(compare)) {
    const content = desired.get(path);
    const sha = sha256Hex(content);
    const disk = diskSha(path);
    const known = owned[path]; // undefined: we never wrote this file
    let action;
    if (disk === sha) action = 'unchanged';
    else if (disk === null) action = 'created';
    else if (known === disk) action = 'updated';
    else if (force) action = 'overwritten';
    else if (known === undefined) action = 'foreign';
    else action = 'kept';

    if (action === 'foreign') {
      foreign.push(path);
      continue;
    }
    if (action === 'kept') {
      tracked[path] = known; // keep the old sha so the file still counts as changed locally next time
      if (sha !== known) warnings.push(`kept ${path}: it was changed locally, so it did not get the new version; rerun with --force to overwrite`);
    } else {
      tracked[path] = sha;
    }
    if (action === 'created' || action === 'updated' || action === 'overwritten') writes.push({ path, content, sha256: sha });
    changes.push({ path, action });
  }

  for (const path of Object.keys(owned).filter((p) => !desired.has(p)).sort(compare)) {
    const disk = diskSha(path);
    if (disk === null) continue; // already gone
    if (disk === owned[path]) {
      deletes.push(path);
      changes.push({ path, action: 'deleted' });
    } else {
      changes.push({ path, action: 'left' });
      warnings.push(`left ${path}: no longer needed, but it was changed locally; delete it yourself if you do not need it`);
    }
  }

  if (foreign.length > 0) {
    throw new Error(
      [
        'refusing to overwrite files that agentmash-crew did not write:',
        ...foreign.map((path) => `  ${path}`),
        'move them away, or rerun with --force to overwrite them',
      ].join('\n'),
    );
  }
  changes.sort((a, b) => compare(a.path, b.path));
  return { writes, deletes, changes, tracked };
}

/**
 * Plans one operation against a snapshot of the repository.
 *
 * state: { manifest: parsed teams.json | null, settingsText: string | null, onDisk: { path: sha256 | null } } covering
 *        every path from statePaths().
 * op:    { type: 'add', name, slug?, members: string[], force? }
 *      | { type: 'remove', team, members?: string[], force? }
 *      | { type: 'update', force? }
 *
 * Throws (before anything is written) on invalid input, foreign files and unparseable settings.
 */
export function planChange(bundle, state, op) {
  const { meta } = bundle;
  const manifest = state.manifest ?? null;
  const warnings = [];
  // add and remove also rewrite every installed file to this bundle's version, which may be older than the one a
  // teammate installed. update exists for exactly that, so it gets no warning.
  const installedVersion = manifest?.source?.version;
  if (op.type !== 'update' && typeof installedVersion === 'string' && installedVersion !== meta.version) {
    warnings.push(
      `the teams here were installed by agentmash-crew ${installedVersion}; this is ${meta.version}, so the files it writes are the ${meta.version} versions`,
    );
  }
  const current = normalizeTeams(bundle, manifest?.teams ?? [], warnings);

  let result;
  if (op.type === 'add') result = applyAdd(bundle, current, op, warnings);
  else if (op.type === 'remove') result = applyRemove(bundle, current, op, warnings);
  else if (op.type === 'update') {
    if (!manifest) throw new Error('no agentmash teams are installed in this repository; nothing to update');
    result = { teams: current, target: null };
  } else throw new Error(`unknown operation ${quote(op.type)}`);

  const teams = [...result.teams].sort((a, b) => compare(a.slug, b.slug));
  const { writes, deletes, changes, tracked } = reconcile(
    desiredFiles(bundle, teams),
    manifest?.files ?? {},
    state.onDisk,
    Boolean(op.force),
    warnings,
  );

  const settingsText = state.settingsText ?? null;
  let settings;
  let createdSettings = false;
  if (teams.length > 0) {
    const merged = mergeSettings(settingsText, meta.hook);
    createdSettings = Boolean(manifest?.createdSettings) || merged.created;
    const action = merged.created ? 'created' : merged.changed ? 'updated' : 'unchanged';
    settings = { path: SETTINGS_PATH, text: merged.text, changed: merged.changed, action };
  } else {
    const removed = unmergeSettings(settingsText, meta.hook.marker, {
      event: meta.hook.event,
      deleteIfEmpty: Boolean(manifest?.createdSettings),
    });
    const action = !removed.changed ? 'unchanged' : removed.text === null ? 'deleted' : 'updated';
    settings = { path: SETTINGS_PATH, text: removed.text, changed: removed.changed, action };
    if (removed.keptGroups > 0) {
      warnings.push(
        `${SETTINGS_PATH}: removed only the crew guard entry from its ${meta.hook.event} hook group, which also holds hooks or keys the installer did not add; the rest stays`,
      );
    }
  }

  let nextManifest = null;
  let manifestText = null;
  if (teams.length > 0) {
    nextManifest = {
      schema: MANIFEST_SCHEMA,
      source: { name: meta.name, version: meta.version, url: meta.url },
      createdSettings,
      teams: teams.map((team) => ({ slug: team.slug, name: team.name, members: team.members })),
      files: sortedObject(tracked),
    };
    manifestText = toJson(nextManifest);
  }
  const manifestOnDisk = state.onDisk[meta.manifestPath] ?? null;
  let manifestAction = 'unchanged';
  if (manifestText === null) {
    if (manifestOnDisk !== null) manifestAction = 'deleted';
  } else if (manifestOnDisk === null) manifestAction = 'created';
  else if (manifestOnDisk !== sha256Hex(manifestText)) manifestAction = 'updated';

  return {
    teams,
    target: result.target,
    targetIsNew: Boolean(result.targetIsNew),
    writes,
    deletes,
    changes,
    settings,
    manifestPath: meta.manifestPath,
    manifest: nextManifest,
    manifestText,
    manifestAction,
    changed: writes.length > 0 || deletes.length > 0 || settings.changed || manifestAction !== 'unchanged',
    warnings,
  };
}
