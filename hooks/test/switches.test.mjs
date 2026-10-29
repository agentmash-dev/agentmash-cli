// The on/off settings a developer writes in their environment or a .env
// (AGENTMASH_HINTS, AGENTMASH_DIFFS, AGENTMASH_WORKTREE, AGENTMASH_STRICT,
// AGENTMASH_DISABLE) take the spellings people use for one: 1, true, on, yes
// and 0, false, off, no, in any case, with a comment after the value in a .env.
// Each of these used to understand one word: AGENTMASH_HINTS=false sent the
// whole prompt, and AGENTMASH_DISABLE=true left AgentMash on. A value none of
// them is keeps what it would share on this machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eventsOf, machine, runHook, session, startServer } from './fixtures.mjs';
import * as lib from '../lib.mjs';

const ON = ['1', 'true', 'on', 'yes', 'TRUE', 'On', ' yes '];
const OFF = ['0', 'false', 'off', 'no', 'FALSE', 'Off', ' no '];

test('a switch reads 1, true, on and yes as on, 0, false, off and no as off, and anything else as neither', () => {
  for (const v of ON) assert.equal(lib.envSwitch(v), true, JSON.stringify(v));
  for (const v of OFF) assert.equal(lib.envSwitch(v), false, JSON.stringify(v));
  for (const v of [undefined, '', '  ']) assert.equal(lib.envSwitch(v), undefined, `${JSON.stringify(v)} is not set`);
  for (const v of ['2', 'disabled', 'nope', '0 # comment', '0#x']) assert.equal(lib.envSwitch(v), null, JSON.stringify(v));
});

/** loadConfig for a checkout whose .env holds `lines`, and maybe a committed config. */
function configWith(lines, committed = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-switches-')));
  fs.writeFileSync(path.join(dir, '.env'), lines.join('\n') + '\n');
  fs.mkdirSync(path.join(dir, '.claude', 'agentmash'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'agentmash', 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:1', room: 'mash_x', ...committed }));
  return lib.loadConfig(dir);
}

// the sharing switches, each with what it is called in config.json
const SHARING = [
  ['AGENTMASH_HINTS', 'shareHints', 'share_hints'],
  ['AGENTMASH_DIFFS', 'streamDiffs', 'stream_diffs'],
  ['AGENTMASH_WORKTREE', 'shareWorktree', 'share_worktree'],
];

test('in a .env, each sharing switch is off for every way of saying off, a comment after it too, and for what it cannot read', () => {
  // whatever the process was started with is not this test's
  for (const [name] of SHARING) delete process.env[name];
  for (const [name, key, committed] of SHARING) {
    for (const v of OFF) assert.equal(configWith([`${name}=${v}`])[key], false, `${name}=${v}`);
    assert.equal(configWith([`${name}=0 # keep it on this machine`])[key], false, 'a comment after the value');
    assert.equal(configWith([`${name}="off" # quoted, then a comment`])[key], false);
    assert.equal(configWith([`${name}=disabled`])[key], false, 'a word it does not know keeps it home');
    for (const v of ON) assert.equal(configWith([`${name}=${v}`], { [committed]: false })[key], true, `${name}=${v} over the committed config`);
    assert.equal(configWith([`${name}=1 # mine go out`], { [committed]: false })[key], true);
    assert.equal(configWith([])[key], true, 'unset: on, by default');
    assert.equal(configWith([`${name}=`])[key], true, 'set to nothing is unset');
    assert.equal(configWith([], { [committed]: false })[key], false, 'unset: as config.json says');
  }
});

test('AGENTMASH_DISABLE switches AgentMash off for every way of saying on, and for what it cannot read; AGENTMASH_STRICT reads the same words', () => {
  delete process.env.AGENTMASH_DISABLE;
  delete process.env.AGENTMASH_STRICT;
  for (const v of ON) assert.equal(configWith([`AGENTMASH_DISABLE=${v}`]).disabled, true, `AGENTMASH_DISABLE=${v}`);
  assert.equal(configWith(['AGENTMASH_DISABLE=true # until the demo']).disabled, true);
  assert.equal(configWith(['AGENTMASH_DISABLE=please']).disabled, true, 'a word it does not know switches it off');
  for (const v of OFF) assert.equal(configWith([`AGENTMASH_DISABLE=${v}`]).disabled, false, `AGENTMASH_DISABLE=${v}`);
  assert.equal(configWith([]).disabled, false);
  assert.equal(configWith(['AGENTMASH_DISABLE=']).disabled, false, 'set to nothing is unset');

  for (const v of ON) assert.equal(configWith([`AGENTMASH_STRICT=${v}`]).strict, true, `AGENTMASH_STRICT=${v}`);
  for (const v of OFF) assert.equal(configWith([`AGENTMASH_STRICT=${v}`], { strict: true }).strict, false, `AGENTMASH_STRICT=${v}`);
  assert.equal(configWith(['AGENTMASH_STRICT=maybe'], { strict: true }).strict, true, 'a word it does not know leaves it to config.json');
  assert.equal(configWith(['AGENTMASH_STRICT=maybe']).strict, false);
});

test('the prompt stays on this machine for AGENTMASH_HINTS=false, =off and =0 with a comment in the .env', async () => {
  const room = await startServer({ holders: [] });
  try {
    for (const line of ['AGENTMASH_HINTS=false', 'AGENTMASH_HINTS=off', 'AGENTMASH_HINTS=0 # keep my prompts on this machine']) {
      const m = machine(room.port, { committed: true });
      fs.writeFileSync(path.join(m.project, '.env'), `${line}\n`);
      const before = room.requests.length;
      const prompt = { session_id: session(), cwd: m.project, hook_event_name: 'UserPromptSubmit', prompt: 'private plan: move billing off the old provider' };
      const ran = await runHook('user_prompt_submit.mjs', prompt, m.env);
      assert.equal(ran.code, 0, line);
      const sent = room.requests.slice(before);
      assert.ok(sent.some((r) => r.path === '/events' && r.body?.event_type === 'prompt'), `${line}: the prompt event still goes, without its text`);
      assert.ok(!JSON.stringify(sent).includes('private plan'), `${line}: the prompt never left`);
    }
  } finally {
    await room.close();
  }
});

test('AGENTMASH_DISABLE=true, =yes and =on report nothing; =1 never did', async () => {
  const room = await startServer({ holders: [] });
  try {
    for (const value of ['1', 'true', 'yes', 'on']) {
      const m = machine(room.port, { committed: true });
      const file_path = path.join(m.project, 'src', 'models', 'user.ts');
      const edit = { session_id: session(), cwd: m.project, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path, old_string: 'id', new_string: 'key' }, tool_response: { success: true } };
      const ran = await runHook('post_tool_use.mjs', edit, { ...m.env, AGENTMASH_DISABLE: value });
      assert.deepEqual([ran.code, ran.stdout], [0, ''], value);
    }
    assert.deepEqual(await eventsOf(room, 1, 500), [], 'switched off, every time');

    // and switched back on, the same edit is reported
    const m = machine(room.port, { committed: true });
    const file_path = path.join(m.project, 'src', 'models', 'user.ts');
    const edit = { session_id: session(), cwd: m.project, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path, old_string: 'id', new_string: 'key' }, tool_response: { success: true } };
    await runHook('post_tool_use.mjs', edit, { ...m.env, AGENTMASH_DISABLE: 'false' });
    assert.equal((await eventsOf(room, 1)).length, 1);
  } finally {
    await room.close();
  }
});
