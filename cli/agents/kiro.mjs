// Kiro: ~/.kiro/hooks/agentmash.json, a file of our own among the person's
// in the folder the Kiro IDE (1.0.182 on) and kiro-cli's V3 engine read every
// hook file from and merge, in Kiro's v1 hook format; each hook runs the
// generic hook (agent_hook.mjs) with --client kiro, answered in the kiro
// dialect (hooks/dialects/kiro.mjs). Its MCP server goes in
// ~/.kiro/settings/mcp.json ($KIRO_HOME/settings), which the IDE and the CLI
// both read.
//
// Three hooks, no more: Kiro shows a card in the chat for every hook it runs,
// and has no setting to hide them.
//
//   PreToolUse        before each of Kiro's writes: the advice, as a refusal
//                     of the first try at a file a teammate is in (Kiro shows
//                     the model nothing a hook says before a tool unless the
//                     hook refuses it); the same edit again goes through
//   PostToolUse       after each write: the report, handed off at once
//   UserPromptSubmit  the prompt's report, and the heads-up about who is at
//                     work, which Kiro adds to the model's context
//
// Not SessionStart: kiro-cli fires it at the first prompt and the IDE has
// been seen not to fire it at all, and the first prompt's heads-up says the
// same. Not Stop: it comes at the end of every turn, and what a Stop hook
// prints can send the agent back to work. Not SessionEnd: kiro-cli's V3
// engine alone has it (2.25.0 on), with a payload nobody has documented, and
// an IDE that does not know a trigger might refuse the whole file.
//
// kiro-cli's default engine (V2, the Amazon Q CLI's) runs only the hooks of
// the agent it is started with, so these reach it only on V3 (kiro-cli --v3,
// or chat.agentEngine). Wiring V2 would mean an agent of ours and changing
// the person's default agent: not done.
//
// Kiro asks the person nothing before running a hook, so there is nothing to
// approve; nothing here ever writes a permission, an autoApprove for the MCP
// server's tools, or a trust setting.

import fs from 'node:fs';
import path from 'node:path';
import {
  addServer,
  agentHookCommand,
  exists,
  hasServer,
  isOurEntry,
  missingScripts,
  outcome,
  readJsonObject,
  removeFile,
  removeServer,
  same,
  serverArgs,
  shown,
  which,
  writeJson,
} from '../agent-kit.mjs';

/** Kiro's write tools (kiro.dev/docs/tools.md), as a hook's matcher: a regex on the tool's name. */
const WRITE_TOOLS = 'fs_write|fs_append|str_replace|delete_file';
/** The format Kiro reads a hook file in. */
const FORMAT = 'v1';
/** A hooks file of ours left with nothing of anyone's, when it is a link we must keep. */
const EMPTY = `{\n  "version": "${FORMAT}",\n  "hooks": []\n}\n`;

/** Kiro's folder: $KIRO_HOME, else ~/.kiro. */
const kiroHome = (places) => process.env.KIRO_HOME || path.join(places.home, '.kiro');

/**
 * Kiro's docs say its settings resolve against KIRO_HOME, and do not say its
 * hooks do (an open issue, kirodotdev/Kiro#11348, says it is not consistent):
 * the hooks go in ~/.kiro/hooks, where the docs say global hooks are read from.
 */
const files = (places) => ({
  hooks: path.join(places.home, '.kiro', 'hooks', 'agentmash.json'),
  mcp: path.join(kiroHome(places), 'settings', 'mcp.json'),
});

/** A hook of ours: its command runs a script from a .agentmash/hooks folder. */
const isOurHook = (hook) => isOurEntry(hook?.action);

/**
 * What login registers with Kiro, as the file it writes: the generic hook for
 * three of Kiro's triggers. The same strings on every run, no version in them.
 */
export function kiroHooks(hookDir) {
  const hook = (name, description, trigger, event, matcher) => ({
    name,
    description,
    trigger,
    ...(matcher ? { matcher } : {}),
    action: { type: 'command', command: agentHookCommand(hookDir, event, 'kiro', { dialect: 'kiro' }) },
    // seconds; the generic hook gives up and lets the agent go on well before
    timeout: 5,
    enabled: true,
  });
  return {
    version: FORMAT,
    hooks: [
      hook('agentmash-before-edit', "AgentMash: says when a teammate's agent is in the file", 'PreToolUse', 'pre_edit', WRITE_TOOLS),
      hook('agentmash-after-edit', "AgentMash: reports the edit to your team's room", 'PostToolUse', 'post_edit', WRITE_TOOLS),
      hook('agentmash-prompt', "AgentMash: reports the prompt, and says who on your team is at work", 'UserPromptSubmit', 'prompt'),
    ],
  };
}

/**
 * Our hooks file read to be written: { config, list } as it is, or { invalid }
 * when it is not Kiro's v1 format, which login does not write into.
 */
function readHooksFile(file) {
  const read = readJsonObject(file);
  if (read.invalid) return { invalid: 'is not valid JSON' };
  const config = read.value;
  if (config.hooks !== undefined && !Array.isArray(config.hooks)) return { invalid: 'has hooks that are not a list' };
  if (config.version !== undefined && config.version !== FORMAT) return { invalid: `is in hook format ${JSON.stringify(config.version)}, not ${FORMAT}` };
  return { config, list: config.hooks ?? [] };
}

export default {
  id: 'kiro',
  name: 'Kiro',
  order: 50,
  env: ['KIRO_HOME'],
  files,
  hooks: kiroHooks,
  detect(places) {
    // kiro-cli, or the IDE's `kiro` launcher; the apps; or Kiro's folder
    const bin = which('kiro-cli', places.toolPath) ?? which('kiro', places.toolPath);
    const apps = places.apps ? ['Kiro.app', 'Kiro CLI.app'].map((name) => path.join(places.apps, name)) : [];
    return { found: Boolean(bin) || [kiroHome(places), path.join(places.home, '.kiro'), ...apps].some(exists), bin };
  },
  connect(places, hookDir) {
    const at = files(places);
    const read = readHooksFile(at.hooks);
    if (read.invalid) return { status: 'skipped', why: `${shown(at.hooks, places)} ${read.invalid} — fix it, then run login again` };
    const want = kiroHooks(hookDir);
    const theirs = read.list.filter((hook) => !isOurHook(hook));
    const changed = read.config.version !== FORMAT || !same(read.list.filter(isOurHook), want.hooks);
    // anything of the person's in our file stays, first, as it was
    if (changed) writeJson(at.hooks, { version: FORMAT, ...read.config, hooks: [...theirs, ...want.hooks] });
    const server = addServer(at.mcp, 'mcpServers', { command: 'node', args: serverArgs(hookDir) });
    const notes = [];
    if (server.status === 'taken') notes.push(`a server called agentmash is in ${shown(at.mcp, places)} already, and not ours: left as it is`);
    if (server.status === 'invalid') notes.push(`${shown(at.mcp, places)} is not valid JSON: the MCP server was not added`);
    const status = changed || server.status === 'added' ? 'connected' : 'already';
    if (status === 'connected') {
      notes.push('Kiro shows the agent a warning by refusing its first edit of a file a teammate is in; the same edit again goes through');
      notes.push('the Kiro IDE runs these hooks, and kiro-cli on its V3 engine (kiro-cli --v3); its default engine runs none of them');
    }
    if (process.env.KIRO_HOME && path.resolve(process.env.KIRO_HOME) !== path.join(places.home, '.kiro')) {
      notes.push(`KIRO_HOME is set: the hooks went in ${shown(at.hooks, places)}, where Kiro's docs say it reads global hooks, and the MCP server in ${shown(at.mcp, places)}`);
    }
    return { status, notes, where: shown(at.hooks, places) };
  },
  disconnect(places) {
    const at = files(places);
    const hooks = { removed: false };
    const read = readJsonObject(at.hooks);
    const list = Array.isArray(read.value?.hooks) ? read.value.hooks : [];
    // a file that cannot be read may still hold ours: said, never guessed at
    if (read.invalid) hooks.invalid = true;
    else if (list.some(isOurHook)) {
      const kept = list.filter((hook) => !isOurHook(hook));
      const rest = Object.keys(read.value).filter((key) => key !== 'hooks' && key !== 'version');
      if (kept.length === 0 && rest.length === 0) {
        removeFile(at.hooks, EMPTY);
        try {
          fs.rmdirSync(path.dirname(at.hooks)); // the hooks folder, when it held only ours
        } catch {
          // the person's hooks are in it
        }
      } else writeJson(at.hooks, { ...read.value, hooks: kept });
      hooks.removed = true;
    }
    return outcome([hooks, at.hooks, places], [removeServer(at.mcp, 'mcpServers'), at.mcp, places]);
  },
  inspect(places) {
    const at = files(places);
    const read = readJsonObject(at.hooks);
    const ours = (Array.isArray(read.value?.hooks) ? read.value.hooks : []).filter(isOurHook);
    const missing = missingScripts(ours.map((hook) => hook.action));
    // the dialect the generic hook answers Kiro in, beside it: without it every answer is silence
    const script = /"([^"]+)"/.exec(ours[0]?.action?.command ?? '')?.[1];
    const dialect = script ? path.join(path.dirname(script), 'dialects', 'kiro.mjs') : null;
    if (script && exists(script) && !exists(dialect)) missing.push(dialect);
    return {
      connected: ours.length > 0,
      invalid: Boolean(read.invalid),
      where: shown(at.hooks, places),
      events: [...new Set(ours.map((hook) => hook.trigger))],
      missing,
      mcp: hasServer(at.mcp, 'mcpServers'),
    };
  },
};
