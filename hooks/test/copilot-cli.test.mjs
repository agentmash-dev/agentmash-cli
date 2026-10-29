// Two agents that run Claude Code's own hooks, and how the room hears of
// their edits. The Copilot CLI may run them from ~/.claude/settings.json
// beside its own (--client copilot): then its edit would be reported twice,
// once as Claude Code's, so the Claude Code hooks step aside for a payload in
// its own camelCase format while its own hooks are there to report it, and
// only then. Devin runs them on purpose, with no --client: its edits, through
// tools Claude Code has none of, say they are Devin's.
//
// The Copilot CLI payloads are written from its hooks reference
// (fixtures/copilot/cli.mjs), not captured live: the guard is held to that
// shape alone, and anything else goes on as it did.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clientTool, ranByCopilotCli } from '../lib.mjs';
import { eventsOf, machine, runHook, session, startServer } from './fixtures.mjs';
import * as copilot from './fixtures/copilot/cli.mjs';

/** A home where `npx agentmash login` connected the Copilot CLI: its own hooks, in its own folder. */
function withCopilotHooks(home) {
  const dir = path.join(home, '.copilot');
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'hooks', 'agentmash.json'), JSON.stringify({ hooks: {} }));
  return dir;
}

const userTs = (m) => path.join(m.project, 'src', 'models', 'user.ts');

test('a payload in the Copilot CLI’s own format, with its own hooks there, is theirs to report; anything else is not', () => {
  const home = machine(1).home;
  const none = path.join(home, '.copilot');
  const hooks = withCopilotHooks(machine(1).home);
  const camel = copilot.preEdit('/r', 's1', 'a.ts', 'a', 'b');
  assert.equal(ranByCopilotCli(camel, null, hooks), true);
  assert.equal(ranByCopilotCli({ sessionId: 's1' }, null, hooks), true);
  assert.equal(ranByCopilotCli({ toolArgs: '{}' }, null, hooks), true);
  assert.equal(ranByCopilotCli(camel, null, none), false, 'no hooks of its own: these are the only ones that report it');
  assert.equal(ranByCopilotCli(camel, 'copilot', hooks), false, 'its own hooks, --client copilot');
  // Claude Code always sends session_id, whatever else is in it
  assert.equal(ranByCopilotCli({ session_id: 's1', tool_name: 'Edit', tool_input: {} }, null, hooks), false);
  assert.equal(ranByCopilotCli({ ...camel, session_id: 's1' }, null, hooks), false);
  assert.equal(ranByCopilotCli({ sessionId: '', toolArgs: '' }, null, hooks), false, 'nothing in either: not its');
  for (const raw of [null, undefined, 'x', [camel]]) assert.equal(ranByCopilotCli(raw, null, hooks), false);
});

test('the Copilot CLI running Claude Code’s hooks beside its own: they ask and report nothing, and its own hooks do', async () => {
  const server = await startServer();
  const m = machine(server.port);
  const env = { ...m.env, COPILOT_HOME: withCopilotHooks(m.home) };
  try {
    const s = session();
    const pre = await runHook('pre_tool_use.mjs', copilot.preEdit(m.project, s, userTs(m), 'id', 'uid'), env, ['--global']);
    assert.deepEqual([pre.code, pre.stdout, pre.stderr], [0, '', '']);
    await runHook('post_tool_use.mjs', copilot.postEdit(m.project, s, userTs(m), 'id', 'uid'), env, ['--global']);
    await runHook('user_prompt_submit.mjs', copilot.prompt(m.project, s, 'add a role'), env, ['--global']);
    assert.deepEqual(server.requests.filter((r) => r.path === '/check' || r.path === '/events'), [], 'nothing asked, nothing reported');

    // its own hooks, --client copilot, on the very same payload
    const own = await runHook('pre_tool_use.mjs', copilot.preEdit(m.project, s, userTs(m), 'id', 'uid'), env, ['--global', '--client', 'copilot']);
    assert.match(JSON.parse(own.stdout).hookSpecificOutput.additionalContext, /alice's agent modified src\/models\/user\.ts/);
    await runHook('post_tool_use.mjs', copilot.postEdit(m.project, s, userTs(m), 'id', 'uid'), env, ['--global', '--client', 'copilot']);
    const [edit] = (await eventsOf(server, 1)).map((r) => r.body);
    assert.equal(edit.tool, 'copilot:edit');
    assert.equal(edit.file_path, 'src/models/user.ts');

    // and Claude Code on the same machine, in Claude Code's format: as it always was
    const claude = { session_id: session(), cwd: m.project, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: userTs(m), old_string: 'id', new_string: 'uid' } };
    const asked = await runHook('pre_tool_use.mjs', claude, env, ['--global']);
    assert.match(JSON.parse(asked.stdout).hookSpecificOutput.additionalContext, /alice's agent/);
  } finally {
    await server.close();
  }
});

test('without hooks of its own, the Copilot CLI’s edit through Claude Code’s hooks is reported as it always was, and not as Devin’s', async () => {
  const server = await startServer();
  const m = machine(server.port);
  // no ~/.copilot/hooks/agentmash.json here
  const env = { ...m.env, COPILOT_HOME: path.join(m.home, '.copilot') };
  try {
    const s = session();
    const pre = await runHook('pre_tool_use.mjs', copilot.preEdit(m.project, s, userTs(m), 'id', 'uid'), env, ['--global']);
    assert.match(JSON.parse(pre.stdout).hookSpecificOutput.additionalContext, /alice's agent/);
    await runHook('post_tool_use.mjs', copilot.postEdit(m.project, s, userTs(m), 'id', 'uid'), env, ['--global']);
    const [edit] = (await eventsOf(server, 1)).map((r) => r.body);
    assert.deepEqual([edit.tool, edit.file_path, edit.session_id], ['edit', 'src/models/user.ts', s]);
  } finally {
    await server.close();
  }
});

test('Devin’s edits through Claude Code’s hooks say they are Devin’s; Claude Code’s own say what they always did', async () => {
  assert.equal(clientTool(null, 'edit'), 'devin:edit');
  assert.equal(clientTool(null, 'write'), 'devin:write');
  assert.equal(clientTool(null, 'apply_patch'), 'devin:apply_patch');
  assert.equal(clientTool(null, 'Edit'), 'Edit');
  assert.equal(clientTool(null, 'Bash'), 'Bash');
  assert.equal(clientTool(null, null), null);
  assert.equal(clientTool('codex', 'apply_patch'), 'codex:apply_patch', 'an agent named by --client is that agent');
  assert.equal(clientTool(null, 'edit', copilot.postEdit('/r', 's', 'a.ts', 'a', 'b')), 'edit', 'the Copilot CLI’s edit has the same name');

  const server = await startServer();
  const m = machine(server.port);
  try {
    const s = session();
    const call = { session_id: s, cwd: m.project, hook_event_name: 'PostToolUse', tool_name: 'edit', tool_input: { path: 'src/models/user.ts', old_string: 'id', new_string: 'uid' } };
    await runHook('post_tool_use.mjs', call, m.env, ['--global']);
    const [edit] = (await eventsOf(server, 1)).map((r) => r.body);
    assert.deepEqual([edit.tool, edit.file_path], ['devin:edit', 'src/models/user.ts']);
  } finally {
    await server.close();
  }
});
