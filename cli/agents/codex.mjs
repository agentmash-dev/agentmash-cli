// Codex: ~/.codex/hooks.json ($CODEX_HOME), the Claude Code hook scripts
// with --global --client codex, and its MCP server as a block of ours on the
// end of config.toml (not `codex mcp add`, which rewrites the whole file in
// Codex's own formatting: seen on 0.160.0). Codex runs no hook until the
// person approves it in /hooks, and it keys that approval to a hash of the
// hook's definition, so every command here is the same string from one
// version of agentmash to the next: a fixed path and fixed arguments, no
// version in it. Nothing here ever writes an approval, or a flag that skips
// one.

import fs from 'node:fs';
import path from 'node:path';
import { parseToml } from '../toml.mjs';
import {
  PRIVATE,
  RUNS_OURS,
  SERVER_NAME,
  SERVER_SCRIPT,
  exists,
  isOurGroup,
  isOurServer,
  mergeEntries,
  missingScripts,
  nodeCommand,
  outcome,
  readJsonObject,
  readText,
  removeFromHooksFile,
  serverArgs,
  shown,
  which,
  writeFileSafely,
  writeJson,
} from '../agent-kit.mjs';

const files = (places) => ({ hooks: path.join(places.codex, 'hooks.json'), config: path.join(places.codex, 'config.toml') });

/** What login registers with Codex: the Claude Code scripts, for Codex's own events and tool names. */
export function codexHooks(hookDir) {
  const run = (script, extra = []) => nodeCommand(hookDir, script, ['--global', '--client', 'codex', ...extra]);
  return {
    PreToolUse: [{ matcher: '^apply_patch$', hooks: [{ type: 'command', command: run('pre_tool_use.mjs'), timeout: 5 }] }],
    PostToolUse: [
      { matcher: '^(apply_patch|Bash)$', hooks: [{ type: 'command', command: run('post_tool_use.mjs', ['--detach']), timeout: 5 }] },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          { type: 'command', command: run('user_prompt_submit.mjs', ['--detach']), timeout: 5 },
          { type: 'command', command: run('prompt_note.mjs'), timeout: 3 },
        ],
      },
    ],
    SessionStart: [{ hooks: [{ type: 'command', command: run('session_start.mjs'), timeout: 5 }] }],
    // SessionEnd hooks get three seconds at most; this one hands its report off at once
    SessionEnd: [{ hooks: [{ type: 'command', command: run('session_end.mjs', ['--detach']), timeout: 3 }] }],
    // advisory only, as in Claude Code: never a block
    Stop: [{ hooks: [{ type: 'command', command: run('stop.mjs'), timeout: 5 }] }],
  };
}

// ── TOML, carefully ─────────────────────────────────────────────────────────
//
// Codex's config.toml is the person's, full of their own settings, and this
// file never rewrites it: our server goes on the end as one block of our own,
// and comes out as exactly that block, so the file is byte for byte what it
// was. `codex mcp add` would do it in one command, and rewrite the whole file
// on the way: on Codex 0.160.0 it reordered a table's keys, turned 120 into
// 120.0 and dropped an `args = []`, all of them the person's.
//
// The file is read first (toml.mjs), and nothing is appended to one that does
// not read, that writes mcp_servers inline (a header may not add to it), or
// that has an agentmash server in any form already: a table, a dotted key, an
// inline table. What would be written is read again before it is, and must
// still read. Coming out, the block as written is cut only when nothing
// follows it before the next table: a key someone added under ours would
// otherwise fall into the table above. Else our table goes by its lines, with
// every table under it (Codex keeps a server's tool approvals in
// [mcp_servers.agentmash.tools.*]), and nothing else is touched either way.
// A block an older login wrote, without env_vars, gains that one line where
// it is, so the approvals under it stay.

const TABLE_HEADER = /^\s*\[{1,2}\s*([^\]]+?)\s*\]{1,2}\s*(?:#.*)?$/;

/** A table's dotted name with its quotes and spaces gone: [mcp_servers."agentmash"] is mcp_servers.agentmash. */
const tableName = (raw) =>
  raw
    .split(/\.(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) => part.trim().replace(/^"(.*)"$/, '$1'))
    .join('.');

/** Each table in the text: { name, start, end } as line indexes, end exclusive. */
function tomlTables(lines) {
  const tables = [];
  lines.forEach((line, i) => {
    const m = TABLE_HEADER.exec(line);
    if (!m) return;
    if (tables.length) tables[tables.length - 1].end = i;
    tables.push({ name: tableName(m[1]), start: i, end: lines.length });
  });
  return tables;
}

const SERVER_TABLE = `mcp_servers.${SERVER_NAME}`;

/**
 * What Codex passes on to our MCP server from its own environment. It starts
 * one with the environment cleared, then a short list of its own (PATH, HOME
 * and the like) and the names a server's env_vars gives (codex-rs/rmcp-client,
 * create_env_for_mcp_server; env_vars since 0.47, long before Codex had the
 * hooks login needs). The server needs both in a session the desktop app
 * starts: with AGENTMASH_WARN_SELF on, it holds a claim under the app's
 * session (lobbySession in hooks/mcp_server.mjs), the one Codex's hooks,
 * which get its whole environment, name with the check before an edit.
 */
const SERVER_ENV = ['AGENTMASH_LOBBY_SESSION', 'AGENTMASH_WARN_SELF'];

/** Our table as login wrote it before it named SERVER_ENV: what env_vars is added to, in place (see registerCodexServer). */
const serverBlockHead = (hookDir) =>
  `\n# agentmash: added by \`npx agentmash login\`; \`npx agentmash logout\` takes it out\n` +
  `[${SERVER_TABLE}]\ncommand = "node"\nargs = [${serverArgs(hookDir).map((a) => JSON.stringify(a)).join(', ')}]\n`;

/** Its env_vars line, the one line a block from an older login lacks. */
const SERVER_ENV_LINE = `env_vars = [${SERVER_ENV.map((name) => JSON.stringify(name)).join(', ')}]\n`;

/** The block login appends to config.toml for Codex's MCP server, when there is no `codex` to do it. */
export function codexServerBlock(hookDir) {
  return serverBlockHead(hookDir) + SERVER_ENV_LINE;
}

/**
 * What config.toml says about MCP servers: { readable, inline, server, ours,
 * headed }. `server` is an agentmash server in any form; `ours` when it starts
 * a hooks folder's mcp_server.mjs; `headed` when it is a [mcp_servers.agentmash]
 * table, the one form that can be cut out by its lines.
 */
function codexServerIn(text) {
  let doc;
  try {
    doc = parseToml(text);
  } catch (err) {
    return { readable: false, why: err.message };
  }
  const servers = doc.value.mcp_servers;
  const inline = servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers) || doc.isInline(servers));
  const server = servers && typeof servers === 'object' && !Array.isArray(servers) ? servers[SERVER_NAME] : undefined;
  const ours = Boolean(server && typeof server === 'object' && isOurServer(server));
  const headed = tomlTables(text.split('\n')).some((t) => t.name === SERVER_TABLE);
  return { readable: true, inline, server: server !== undefined, ours, headed };
}

/** Whether the text after `at` reaches a table header, or the end, before anything else. */
const blockEndsCleanly = (text, at) => {
  const next = text.slice(at).split('\n').find((line) => line.trim() && !/^\s*#/.test(line));
  return next === undefined || TABLE_HEADER.test(next);
};

/** config.toml without our server: our block as written when nothing follows it in its table, else our tables by their lines. */
function withoutCodexServer(text, hookDir) {
  const block = codexServerBlock(hookDir);
  const at = text.lastIndexOf(block);
  // Cut as written, then still look for tables of ours: a header straight
  // after the block can be one of them (Codex keeps tool approvals in
  // [mcp_servers.agentmash.tools.*]), and it must go with the server.
  if (at !== -1 && blockEndsCleanly(text, at + block.length)) text = text.slice(0, at) + text.slice(at + block.length);
  const lines = text.split('\n');
  const drop = new Set();
  for (const t of tomlTables(lines)) {
    if (t.name !== SERVER_TABLE && !t.name.startsWith(`${SERVER_TABLE}.`)) continue;
    for (let i = t.start; i < t.end; i++) drop.add(i);
    // our comment above it, and the blank line we put before that, if they are still there
    if (t.start > 0 && /^# agentmash: added by/.test(lines[t.start - 1])) {
      drop.add(t.start - 1);
      if (t.start > 1 && lines[t.start - 2] === '') drop.add(t.start - 2);
    }
  }
  return lines.filter((_, i) => !drop.has(i)).join('\n');
}

/**
 * Whether Codex has been told to trust each of our hooks: for each, Codex
 * keeps `[hooks.state."<hooks.json>:<event>:<group>:<handler>"]` with a
 * trusted_hash in config.toml once the person approves it in /hooks. Read
 * only. That a hash is there says it was approved; whether the definition has
 * changed since is Codex's to say, which is why our commands never change.
 */
function codexApproval(places, hooks) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(places.codex, 'config.toml'), 'utf8');
  } catch {
    // no config.toml: nothing approved
  }
  const source = path.join(places.codex, 'hooks.json');
  let total = 0;
  let approved = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const label = event.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase());
    groups.forEach((group, g) => {
      if (!isOurGroup(group)) return;
      group.hooks.forEach((_, h) => {
        total += 1;
        const key = `${source}:${label}:${g}:${h}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const at = text.indexOf(`"${key}"`);
        if (at === -1) return;
        // its table: the line naming it ([hooks.state."<key>"], or an inline
        // table on that line), and the lines after it up to the next table
        const after = text.slice(at);
        const next = after.slice(1).search(/\n\s*\[/);
        if (/trusted_hash\s*=\s*"sha256:/.test(next === -1 ? after : after.slice(0, next + 1))) approved += 1;
      });
    });
  }
  return { approved, total };
}

/**
 * Codex's MCP server, as our block on the end of config.toml (see "TOML,
 * carefully"): { status: added | already | skipped, why }.
 */
function registerCodexServer(places, hookDir) {
  const file = files(places).config;
  let text;
  try {
    text = readText(file) ?? ''; // no config.toml yet
  } catch (err) {
    // one that is there is the person's, whether or not it can be read: never written over
    return { status: 'skipped', why: `it could not be read (${err.code ?? err.message})` };
  }
  const found = codexServerIn(text);
  if (!found.readable) return { status: 'skipped', why: `it could not be read as TOML (${found.why})` };
  if (found.inline) return { status: 'skipped', why: 'it writes mcp_servers inline, which a table cannot be added to' };
  const block = codexServerBlock(hookDir);
  if (found.ours && text.includes(block)) return { status: 'already' };
  if (found.server && !(found.ours && found.headed)) {
    return { status: 'skipped', why: 'it has a server called agentmash already, not one login wrote' };
  }
  // Ours as an older login wrote it, without env_vars: the line goes in after
  // it, in our table, and the rest stays where it is, the tool approvals Codex
  // keeps under it ([mcp_servers.agentmash.tools.*]) and anything added since.
  const head = serverBlockHead(hookDir);
  const at = found.ours ? text.lastIndexOf(head) : -1;
  if (at !== -1 && !/^\s*env_vars\s*=/.test(text.slice(at + head.length))) {
    const added = text.slice(0, at + head.length) + SERVER_ENV_LINE + text.slice(at + head.length);
    // one that would not read so (an env_vars of their own further down our table) is replaced, below
    if (codexServerIn(added).ours) {
      writeFileSafely(file, added, { mode: PRIVATE });
      return { status: 'added' };
    }
  }
  // ours, but from another hooks folder or rewritten since: replaced by this one
  const next = (found.ours ? withoutCodexServer(text, hookDir) : text) + block;
  try {
    parseToml(next);
  } catch (err) {
    return { status: 'skipped', why: `it would not read as TOML with the server added (${err.message})` };
  }
  writeFileSafely(file, next, { mode: PRIVATE });
  return { status: 'added' };
}

/**
 * Codex's MCP server out again, only when it is ours, and only into a file
 * that still reads: { removed, invalid }.
 */
function unregisterCodexServer(places, hookDir) {
  const file = files(places).config;
  let text;
  try {
    text = readText(file);
  } catch {
    return { removed: false, invalid: true }; // there, and may hold ours
  }
  if (text === null) return { removed: false };
  const found = codexServerIn(text);
  if (!found.readable) return { removed: false, invalid: text.includes(SERVER_SCRIPT) && RUNS_OURS.test(text) };
  if (!found.ours || !found.headed) return { removed: false };
  const next = withoutCodexServer(text, hookDir);
  try {
    parseToml(next);
  } catch {
    return { removed: false, invalid: true };
  }
  writeFileSafely(file, next, { mode: PRIVATE });
  return { removed: true };
}

export default {
  id: 'codex',
  name: 'Codex',
  order: 10,
  env: ['CODEX_HOME'],
  files,
  hooks: codexHooks,
  // what the person does before Codex runs any of it, said by `tools` and doctor while inspect counts any unapproved
  approvalHint: { short: 'open codex, type /hooks', long: 'open codex, type /hooks, and approve agentmash', approvedIn: '/hooks' },
  detect(places) {
    const bin = which('codex', places.toolPath);
    return { found: Boolean(bin) || exists(places.codex), bin };
  },
  connect(places, hookDir) {
    const at = files(places);
    const read = readJsonObject(at.hooks);
    if (read.invalid) return { status: 'skipped', why: `${shown(at.hooks, places)} is not valid JSON — fix it, then run login again` };
    const config = read.value;
    const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks) ? config.hooks : {};
    const changed = mergeEntries(hooks, codexHooks(hookDir), isOurGroup);
    if (changed) writeJson(at.hooks, { ...config, hooks });
    const notes = [];
    const server = registerCodexServer(places, hookDir);
    if (server.status === 'skipped') {
      notes.push(`the MCP server was not added to ${shown(at.config, places)}: ${server.why}; the hooks work without it`);
    }
    const { approved, total } = codexApproval(places, hooks);
    if (approved < total) notes.push('open codex, type /hooks, and approve agentmash: Codex runs no hook until you do');
    return { status: changed || server.status === 'added' ? 'connected' : 'already', notes, where: shown(at.hooks, places) };
  },
  disconnect(places, hookDir) {
    const at = files(places);
    const hooks = removeFromHooksFile(at.hooks, isOurGroup, ['hooks']);
    const server = unregisterCodexServer(places, hookDir);
    return outcome([hooks, at.hooks, places], [server, at.config, places]);
  },
  inspect(places) {
    const at = files(places);
    const read = readJsonObject(at.hooks);
    const hooks = read.value?.hooks && typeof read.value.hooks === 'object' ? read.value.hooks : {};
    const ours = Object.values(hooks).flatMap((groups) => (Array.isArray(groups) ? groups.filter(isOurGroup) : []));
    let config = '';
    try {
      config = fs.readFileSync(at.config, 'utf8');
    } catch {
      // none
    }
    const server = codexServerIn(config);
    return {
      connected: ours.length > 0,
      invalid: Boolean(read.invalid),
      where: shown(at.hooks, places),
      events: Object.keys(hooks).filter((e) => Array.isArray(hooks[e]) && hooks[e].some(isOurGroup)),
      missing: missingScripts(ours.flatMap((g) => g.hooks)),
      approval: codexApproval(places, hooks),
      mcp: Boolean(server.ours),
    };
  },
};
