// What passes between an agent and a hook on Windows, where an agent can run
// its hooks through PowerShell (Gemini CLI does): PowerShell can put a byte
// order mark in front of what it pipes in, and re-encode what comes back in
// the console's code page. So a hook reads its input past a byte order mark,
// and answers in ASCII JSON, which reads back as the very same words.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asciiJson, parseJson } from '../lib.mjs';
import { HOLDER, machine, runHook, session, startServer } from './fixtures.mjs';
import * as before from './fixtures/gemini/before_tool.mjs';

const BOM = '\uFEFF';
const ASCII = /^[\x00-\x7f]*$/;

/** A teammate whose name and prompt are not ASCII, in the file the edit is about. */
const ZOE = { ...HOLDER, developer: 'zoë', task_hint: 'naïve soft deletes — and 👍' };

const edit = (m, s) => ({
  session_id: s,
  cwd: m.project,
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: path.join(m.project, 'src', 'models', 'user.ts'), old_string: 'id', new_string: 'uid' },
});

test('a payload behind a byte order mark is read as the payload', () => {
  assert.deepEqual(parseJson(`${BOM}{"session_id":"s"}`), { session_id: 's' });
  assert.deepEqual(parseJson('{"session_id":"s"}'), { session_id: 's' });
  assert.equal(parseJson(`${BOM}not json`), null);
  assert.equal(parseJson(`x${BOM}{}`), null, 'only a mark at the very start');
});

// A byte order mark is invisible in an editor, and a tool that strips stray ones
// would take it out of a regex or a test without a word: the regex would then
// take nothing out, the test would send no mark, and every test here would
// still pass. So the hooks write it as an escape.
test('the hooks and the Cursor adapter write a byte order mark as an escape, never as the character', () => {
  const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const sources = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.name === 'node_modules'
        ? []
        : entry.isDirectory()
          ? sources(path.join(dir, entry.name))
          : entry.name.endsWith('.mjs')
            ? [path.join(dir, entry.name)]
            : []
    );
  const files = [...sources(path.join(root, 'hooks')), ...sources(path.join(root, 'clients'))];
  assert.ok(files.length > 20, 'found the sources');
  for (const file of files) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /[\uFEFF\uFFFF]/, path.relative(root, file));
});

test('a JSON answer goes out in ASCII and reads back the same; anything else is left as it is', () => {
  const payload = { systemMessage: 'zoë — naïve 👍', n: 1 };
  const said = asciiJson(JSON.stringify(payload));
  assert.match(said, ASCII);
  assert.deepEqual(JSON.parse(said), payload);
  assert.ok(said.includes('\\ud83d\\udc4d'), 'a character past the BMP as its two halves');
  assert.equal(asciiJson('{"a":"plain"}'), '{"a":"plain"}');
  assert.equal(asciiJson('[AgentMash: PARALLEL EDIT] zoë — here\n'), '[AgentMash: PARALLEL EDIT] zoë — here\n', 'plain text is not JSON');
  assert.equal(asciiJson('"zoë"'), '"zoë"', 'only an object or a list is a hook answer');
  assert.equal(asciiJson(''), '');
});

test('the pre-edit hook reads a payload behind a byte order mark, and answers in ASCII', async () => {
  const server = await startServer({ holders: [ZOE] });
  const m = machine(server.port);
  try {
    const res = await runHook('pre_tool_use.mjs', BOM + JSON.stringify(edit(m, session())), m.env, ['--global']);
    assert.equal(res.code, 0, res.stderr);
    assert.ok(server.requests.some((r) => r.path === '/check'), 'it asked the room');
    assert.match(res.stdout, ASCII, 'nothing for PowerShell to re-encode');
    const context = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /zoë's agent/);
    assert.match(context, /naïve soft deletes — and 👍/u);
  } finally {
    await server.close();
  }
});

test('the generic hook, as Gemini CLI runs it, reads past a byte order mark and answers in ASCII', async () => {
  const server = await startServer({ holders: [ZOE] });
  const m = machine(server.port);
  try {
    const payload = before.replace(m.project, session(), path.join(m.project, 'src', 'models', 'user.ts'), 'id: string', 'id: string; role: string');
    const res = await runHook('agent_hook.mjs', BOM + JSON.stringify(payload), m.env, ['pre_edit', '--global', '--client', 'gemini']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, ASCII);
    const refused = JSON.parse(res.stdout);
    assert.equal(refused.decision, 'deny');
    assert.match(refused.reason, /^\[AgentMash: PARALLEL EDIT\] zoë's agent modified src\/models\/user\.ts/);
  } finally {
    await server.close();
  }
});

// A console program started by a process with no console of its own (a hook
// run by a GUI agent, the git client backgrounded by a GUI git client) opens a
// console window on Windows unless it is told not to: one flashing up for
// every git the hooks run, at every prompt and edit.
test('every process the hooks start, git each time, is started without a console window', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../lib.mjs', import.meta.url)), 'utf8');
  const calls = [];
  for (const m of source.matchAll(/\b(?:execFileSync|execFile|spawnSync|spawn)\(/g)) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    calls.push(source.slice(m.index, end + 1));
  }
  // git config for the email, gitIn's git, and detach's own process
  assert.ok(calls.length >= 3, `${calls.length} calls`);
  for (const call of calls) assert.match(call, /windowsHide: true/, call.slice(0, 120));
});
