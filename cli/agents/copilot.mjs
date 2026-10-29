// GitHub Copilot: ~/.copilot/hooks/agentmash.json ($COPILOT_HOME), a file of
// its own, in the format VS Code's agent and the Copilot CLI both read, with
// --client copilot; its MCP server in ~/.copilot/mcp-config.json, and in VS
// Code's user profile by `code --add-mcp`.

import fs from 'node:fs';
import path from 'node:path';
import {
  SERVER_NAME,
  addServer,
  exists,
  hasServer,
  isOurEntry,
  missingScripts,
  nodeCommand,
  outcome,
  readJsonObject,
  removeFile,
  removeServer,
  runTool,
  same,
  serverArgs,
  shown,
  which,
  writeJson,
} from '../agent-kit.mjs';

const files = (places) => ({
  hooks: path.join(places.copilot, 'hooks', 'agentmash.json'),
  mcp: path.join(places.copilot, 'mcp-config.json'),
  vscode: path.join(places.vscodeUser, 'mcp.json'),
});

/**
 * What login registers with GitHub Copilot, in the format VS Code's agent and
 * the Copilot CLI both read (PascalCase events, flat entries, no version):
 * VS Code reads `timeout` and the CLI `timeoutSec`. VS Code runs every entry
 * for every tool, whatever a matcher says, so the scripts sort the tools
 * themselves. No SessionEnd: VS Code has no such event.
 */
export function copilotHooks(hookDir) {
  const entry = (script, timeout, extra = []) => ({
    type: 'command',
    command: nodeCommand(hookDir, script, ['--global', '--client', 'copilot', ...extra]),
    timeout,
    timeoutSec: timeout,
  });
  return {
    hooks: {
      PreToolUse: [entry('pre_tool_use.mjs', 5)],
      PostToolUse: [entry('post_tool_use.mjs', 5, ['--detach'])],
      UserPromptSubmit: [entry('user_prompt_submit.mjs', 5, ['--detach']), entry('prompt_note.mjs', 3)],
      SessionStart: [entry('session_start.mjs', 5)],
      Stop: [entry('stop.mjs', 5)],
    },
  };
}

export default {
  id: 'copilot',
  name: 'GitHub Copilot',
  order: 30,
  env: ['COPILOT_HOME'],
  files,
  hooks: copilotHooks,
  detect(places) {
    const bin = which('copilot', places.toolPath);
    const code = which('code', places.toolPath);
    return { found: Boolean(bin || code) || exists(places.copilot), bin, code };
  },
  connect(places, hookDir) {
    const at = files(places);
    const want = copilotHooks(hookDir);
    const read = readJsonObject(at.hooks);
    const changed = read.invalid || !same(read.value, want);
    if (changed) writeJson(at.hooks, want);
    const notes = [];
    const cli = addServer(at.mcp, 'mcpServers', { type: 'local', command: 'node', args: serverArgs(hookDir), env: {}, tools: ['*'] });
    if (cli.status === 'taken') notes.push(`a server called agentmash is in ${shown(at.mcp, places)} already, and not ours: left as it is`);
    if (cli.status === 'invalid') notes.push(`${shown(at.mcp, places)} is not valid JSON: the MCP server was not added for the Copilot CLI`);
    let vscode = 'already';
    if (!hasServer(at.vscode, 'servers')) {
      const code = which('code', places.toolPath);
      const entry = JSON.stringify({ name: SERVER_NAME, command: 'node', args: serverArgs(hookDir) });
      if (code && runTool(code, ['--add-mcp', entry], places).ok) vscode = 'added';
      else {
        vscode = 'manual';
        notes.push(`VS Code: no \`code\` command to add the MCP server with; add it yourself: code --add-mcp '${entry}'`);
      }
    }
    const status = changed || cli.status === 'added' || vscode === 'added' ? 'connected' : 'already';
    if (status === 'connected') notes.push('VS Code runs these hooks while chat.useHooks is on (its default); the Copilot CLI from 1.0.86');
    return { status, notes, where: shown(at.hooks, places) };
  },
  disconnect(places) {
    const at = files(places);
    const hooks = { removed: false };
    const read = readJsonObject(at.hooks);
    if (read.invalid) hooks.invalid = true;
    else if (read.existed && Object.values(read.value.hooks ?? {}).flat().some(isOurEntry)) {
      removeFile(at.hooks, '{}\n');
      try {
        fs.rmdirSync(path.dirname(at.hooks)); // the hooks folder, when it held only ours
      } catch {
        // somebody else's hooks are in it
      }
      hooks.removed = true;
    }
    return outcome(
      [hooks, at.hooks, places],
      [removeServer(at.mcp, 'mcpServers'), at.mcp, places],
      [removeServer(at.vscode, 'servers'), at.vscode, places]
    );
  },
  inspect(places) {
    const at = files(places);
    const read = readJsonObject(at.hooks);
    const entries = Object.values(read.value?.hooks ?? {}).flat().filter(isOurEntry);
    return {
      connected: entries.length > 0,
      invalid: Boolean(read.invalid),
      where: shown(at.hooks, places),
      events: Object.keys(read.value?.hooks ?? {}),
      missing: missingScripts(entries),
      mcp: hasServer(at.mcp, 'mcpServers'),
      vscodeMcp: hasServer(at.vscode, 'servers'),
    };
  },
};
