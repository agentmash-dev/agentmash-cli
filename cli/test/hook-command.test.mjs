// `npx agentmash hook`: the line a person pastes into any agent's hook
// configuration, and the same hook run once by hand. What these tests pin:
// the printed line is byte for byte the one every connector builds (Codex
// keys a person's approval to it), the same arguments print the same bytes,
// stdout carries the line and nothing else, a run hands agent_hook.mjs
// exactly that line's arguments, and a run with arguments that do not read
// still answers, as a hook must.
//
// Every run has a home of its own (AGENTMASH_HOME, HOME): nothing of the
// developer's is read, and nothing is installed there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { agentHookCommand } from '../agent-kit.mjs';
import { HOOK_EVENTS, parseHookArgs } from '../hook.mjs';

const CLI_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(CLI_DIR);
const MODULE = pathToFileURL(path.join(CLI_DIR, 'hook.mjs')).href;
const CLI = path.join(CLI_DIR, 'agentmash.mjs');
const VERSION = JSON.parse(fs.readFileSync(path.join(CLI_DIR, 'package.json'), 'utf8')).version;
// what `hook` is as the commands table calls it: cmdHook with the words after `hook`
const RUNNER = 'const m = await import(process.argv[1]); await m.cmdHook(process.argv.slice(2));';

const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTMASH_') && k !== 'NO_COLOR'));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function home() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-hook-cmd-')));
  return { dir, hooks: path.join(dir, '.agentmash', 'hooks') };
}

function exec(argv, { env = {}, input = null, cwd = os.tmpdir() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { cwd, env: { ...baseEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr: strip(stderr) }));
    child.stdin.end(input ?? '');
  });
}

/** `npx agentmash hook <args>`, in a home of its own. */
const hook = (args, { dir, env = {}, input = null } = {}) =>
  exec(['--input-type=module', '-e', RUNNER, MODULE, ...args], { env: { AGENTMASH_HOME: dir, HOME: dir, USERPROFILE: dir, ...env }, input });

/** A stand-in for the installed hook: says what it was run with, and what it read. */
function installStandIn(hooks, { dialects = ['claude', 'json'] } = {}) {
  fs.mkdirSync(path.join(hooks, 'dialects'), { recursive: true });
  for (const d of dialects) fs.writeFileSync(path.join(hooks, 'dialects', `${d}.mjs`), 'export default {};\n');
  fs.writeFileSync(
    path.join(hooks, 'agent_hook.mjs'),
    [
      "import fs from 'node:fs';",
      "const input = fs.readFileSync(0, 'utf8');",
      'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input }));',
      '',
    ].join('\n')
  );
}

/** Whether agentmash.mjs's commands table has `name` yet (the registration is the integrator's). */
function registered(name) {
  const text = fs.readFileSync(CLI, 'utf8');
  const table = /\nconst commands = \{([\s\S]*?)\n\};/.exec(text)?.[1] ?? '';
  return new RegExp(`^\\s+'?${name}'?:`, 'm').test(table);
}

test('the events are agent_hook.mjs\'s own', () => {
  const source = fs.readFileSync(path.join(REPO, 'hooks', 'agent_hook.mjs'), 'utf8');
  const listed = /const EVENTS = \[([^\]]*)\]/.exec(source)?.[1];
  assert.ok(listed, 'agent_hook.mjs lists its EVENTS');
  assert.deepEqual(HOOK_EVENTS, [...listed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
});

test('--print-command prints the line every connector builds, and nothing else on stdout', async () => {
  const { dir, hooks } = home();
  for (const event of HOOK_EVENTS) {
    const res = await hook(['--print-command', '--client', 'mytool', '--event', event], { dir });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout, `${agentHookCommand(hooks, event, 'mytool')}\n`);
  }
  const res = await hook(['--print-command', '--client', 'mytool', '--event', 'pre_edit'], { dir });
  assert.equal(res.stdout, `node "${path.join(hooks, 'agent_hook.mjs')}" pre_edit --global --client mytool\n`);
});

test('the same arguments print the same bytes, in whatever order they come, with no version in them', async () => {
  const { dir, hooks } = home();
  const want = `${agentHookCommand(hooks, 'post_edit', 'mytool', { dialect: 'plain', input: 'normalized' })}\n`;
  const orders = [
    ['--print-command', '--client', 'mytool', '--event', 'post_edit', '--dialect', 'plain', '--input', 'normalized'],
    ['--print-command', 'post_edit', '--input', 'normalized', '--dialect', 'plain', '--client', 'mytool'],
    ['post_edit', '--client=mytool', '--dialect=plain', '--input=normalized', '--print-command'],
    // a line copied from a connector says --global already, which changes nothing
    ['--print-command', 'post_edit', '--global', '--client', 'mytool', '--dialect', 'plain', '--input', 'normalized'],
  ];
  for (const args of orders) {
    const res = await hook(args, { dir });
    assert.equal(res.code, 0, `${args.join(' ')}: ${res.stderr}`);
    assert.equal(res.stdout, want, args.join(' '));
  }
  assert.equal(want, 'node "' + path.join(hooks, 'agent_hook.mjs') + '" post_edit --global --client mytool --dialect plain --input normalized\n');
  assert.ok(!want.includes(VERSION), 'no version in the line');
});

test('--json gives the line quoted for a JSON config, and the dialect it answers in', async () => {
  const { dir, hooks } = home();
  const res = await hook(['--print-command', '--client', 'gemini', '--event', 'pre_edit', '--json'], { dir });
  assert.equal(res.code, 0, res.stderr);
  const said = JSON.parse(res.stdout);
  assert.deepEqual(said, {
    command: agentHookCommand(hooks, 'pre_edit', 'gemini'),
    event: 'pre_edit',
    client: 'gemini',
    // a client with a dialect named like it answers in that one
    dialect: 'gemini',
    installed: false,
  });
});

test('what is missing goes to stderr: the hook before login, a dialect login has not copied, the dialect left to default', async () => {
  const { dir, hooks } = home();
  let res = await hook(['--print-command', '--client', 'mytool', '--event', 'pre_edit'], { dir });
  assert.match(res.stderr, /agent_hook\.mjs is not on this machine yet: npx agentmash login copies it/);
  assert.match(res.stderr, /answers in the claude dialect \(Claude Code's hook JSON\); --dialect picks another: .*\bjson\b/);

  installStandIn(hooks, { dialects: ['claude'] });
  res = await hook(['--print-command', '--client', 'mytool', '--event', 'pre_edit'], { dir });
  assert.equal(res.code, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /not on this machine/);

  // in the package, not yet in this machine's copy
  res = await hook(['--print-command', '--client', 'mytool', '--event', 'pre_edit', '--dialect', 'plain'], { dir });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /the plain dialect is not in .*dialects yet: npx agentmash login copies it/);
  assert.doesNotMatch(res.stderr, /answers in/, 'a dialect named is not explained');
  assert.equal(res.stdout, `${agentHookCommand(hooks, 'pre_edit', 'mytool', { dialect: 'plain' })}\n`);
});

test('an agent agentmash connects itself is pointed at tools add', async () => {
  const { dir } = home();
  const res = await hook(['--print-command', '--client', 'gemini', '--event', 'pre_edit'], { dir });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /agentmash connects gemini itself: npx agentmash tools add gemini/);
  for (const client of ['mytool', 'index']) {
    const other = await hook(['--print-command', '--client', client, '--event', 'pre_edit'], { dir });
    assert.equal(other.code, 0, other.stderr);
    assert.doesNotMatch(other.stderr, /tools add/, client);
  }
});

test('--print-command refuses what would make a line that never answers, and prints no line', async () => {
  const { dir } = home();
  const cases = [
    [['--print-command', '--client', 'mytool'], /say which event/],
    [['--print-command', '--client', 'mytool', '--event', 'pre_tool_use'], /unknown event "pre_tool_use"/],
    [['--print-command', '--event', 'pre_edit'], /--client names the agent/],
    [['--print-command', '--client', 'My Tool', '--event', 'pre_edit'], /--client "My Tool": a-z/],
    [['--print-command', '--client', 'a'.repeat(22), '--event', 'pre_edit'], /--client "a{22}"/],
    [['--print-command', '--client', 'mytool', '--event', 'pre_edit', '--dialect', 'klingon'], /no dialect "klingon": there are .*\bclaude\b/],
    [['--print-command', '--client', 'mytool', '--event', 'pre_edit', '--dialect', '../lib'], /no dialect "\.\.\/lib"/],
    [['--print-command', '--client', 'mytool', '--event', 'pre_edit', '--input', 'raw'], /--input is auto, native, normalized/],
    [['--print-command', 'pre_edit', '--event', 'stop', '--client', 'mytool'], /two events named: pre_edit and --event stop/],
    [['--print-command', '--client', 'mytool', '--event', 'pre_edit', '--clinet', 'x'], /unknown option --clinet/],
    [['--print-command', '--client', 'mytool', '--client', 'other', '--event', 'pre_edit'], /--client is given twice/],
    [['--print-command', '--client', '--event', 'pre_edit'], /--client needs a value/],
    [['--print-command=yes', '--client', 'mytool', '--event', 'pre_edit'], /--print-command takes no value/],
  ];
  for (const [args, said] of cases) {
    const res = await hook(args, { dir });
    assert.equal(res.code, 1, args.join(' '));
    assert.equal(res.stdout, '', args.join(' '));
    assert.match(res.stderr, said, args.join(' '));
  }
});

test('a flag left without its value does not swallow the next one', () => {
  const args = parseHookArgs(['--print-command', '--client', '--event', 'stop']);
  assert.equal(args.event, 'stop');
  assert.equal(args.client, undefined);
  assert.deepEqual(args.problems, ['--client needs a value']);
});

test('a run hands this machine\'s agent_hook.mjs the printed line\'s own arguments, and what was piped in', async () => {
  const { dir, hooks } = home();
  installStandIn(hooks);
  const input = JSON.stringify({ agentmash: 1, session_id: 's1', cwd: dir, files: ['a.ts'] });
  const res = await hook(['--client', 'mytool', '--dialect', 'json', 'pre_edit'], { dir, input });
  assert.equal(res.code, 0, res.stderr);
  const ran = JSON.parse(res.stdout);
  assert.equal(ran.input, input);
  const printed = (await hook(['--print-command', '--client', 'mytool', '--dialect', 'json', '--event', 'pre_edit'], { dir })).stdout;
  const script = `node "${path.join(hooks, 'agent_hook.mjs')}" `;
  assert.ok(printed.startsWith(script));
  assert.deepEqual(ran.argv, printed.slice(script.length).trim().split(' '));
  assert.deepEqual(ran.argv, ['pre_edit', '--global', '--client', 'mytool', '--dialect', 'json']);
  assert.doesNotMatch(res.stderr, /package's copy/);
});

test('with nothing installed, a run uses the package\'s own hook, and answers in its dialect', async () => {
  const { dir } = home();
  const res = await hook(['pre_edit', '--client', 'mytool', '--dialect', 'json'], {
    dir,
    env: { AGENTMASH_DISABLE: '1' },
    input: JSON.stringify({ agentmash: 1, session_id: 's1', cwd: dir, files: ['a.ts'] }),
  });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /is not there yet \(npx agentmash login copies it\): running this package's copy/);
  assert.deepEqual(JSON.parse(res.stdout), {
    agentmash: 1,
    event: 'pre_edit',
    action: 'allow',
    level: null,
    text: null,
    files: [],
    strict: false,
  });
});

test('a run with arguments that do not read still answers, neutrally, and exits 0', async () => {
  const { dir } = home();
  for (const args of [
    ['pre_tool_use', '--client', 'mytool', '--dialect', 'json'],
    ['pre_edit', '--dialect', 'json'],
    ['pre_edit', '--client', 'mytool', '--dialect', 'json', '--bogus'],
  ]) {
    const res = await hook(args, { dir, input: '{}' });
    assert.equal(res.code, 0, `${args.join(' ')}: ${res.stderr}`);
    assert.equal(JSON.parse(res.stdout).action, 'allow', args.join(' '));
    assert.match(res.stderr, /!/, args.join(' '));
  }
});

test('no arguments, or --help, is the usage, which says never to register npx', async () => {
  const { dir } = home();
  for (const args of [[], ['--help']]) {
    const res = await hook(args, { dir });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /--print-command --client <id> --event <event>/);
    assert.match(res.stdout, /register the node line, never npx/);
  }
});

test('through agentmash.mjs, once the commands table has it, the line is the same', { skip: !registered('hook') && 'hook is not in the commands table yet' }, async () => {
  const { dir, hooks } = home();
  const res = await exec([CLI, 'hook', '--print-command', '--client', 'mytool', '--event', 'stop', '--dialect', 'plain'], {
    env: { AGENTMASH_HOME: dir, HOME: dir, USERPROFILE: dir },
  });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, `${agentHookCommand(hooks, 'stop', 'mytool', { dialect: 'plain' })}\n`);
});
