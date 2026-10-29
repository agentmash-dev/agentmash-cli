// Qwen Code, as `npx agentmash login` connects it: our hooks in the `hooks` of
// the person's ~/.qwen/settings.json, after theirs, and our MCP server in its
// `mcpServers`, beside theirs; `logout` and `tools remove qwen` take out
// exactly that. Every test runs in a home of its own (fixtures/machine.mjs),
// with qwen replaced by a stand-in and QWEN_HOME cleared unless a test sets
// it: nothing here may touch the real ~/.qwen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS } from '../tools.mjs';
import { CLI_DIR, json, machine, md5, run, runsOurs, shownHere, startServer } from './fixtures/machine.mjs';

/** What is already in the person's settings, which must come through login and logout untouched. */
const THEIRS = {
  $version: 4,
  security: { auth: { selectedType: 'openai' } },
  model: { name: 'qwen3-coder-plus' },
  hooks: { PreToolUse: [{ matcher: 'run_shell_command', hooks: [{ type: 'command', name: 'guard', command: './guard.sh', timeout: 10 }] }] },
  mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_theirs' } } },
};

/** A machine with Qwen Code on it: qwen on the tool path, and ~/.qwen/settings.json, private, as the person left it. */
function qwenMachine({ qwen = true, cli = true, settings = `${JSON.stringify(THEIRS, null, 2)}\n` } = {}) {
  const m = machine({
    with: cli ? ['qwen'] : [],
    codex: false,
    cursor: false,
    copilot: false,
    scripts: { qwen: `if (process.argv[2] === '--version') console.log('0.24.7');` },
  });
  const dir = path.join(m.home, '.qwen');
  const at = { dir, settings: path.join(dir, 'settings.json') };
  if (qwen) {
    fs.mkdirSync(dir);
    if (settings !== null) {
      fs.writeFileSync(at.settings, settings, { mode: 0o600 });
      fs.chmodSync(at.settings, 0o600);
    }
  }
  return { ...m, at };
}

const login = (server, env, extra = []) => run(['login', '--server', server.url, '--no-open', ...extra], env);
const command = (m, event) => `node "${path.join(m.hookDir, 'agent_hook.mjs')}" ${event} --global --client qwen --dialect qwen`;
const mode = (file) => fs.statSync(file).mode & 0o777;
const POSIX = { skip: process.platform === 'win32' && 'POSIX modes, paths and symlinks' };
const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'SessionEnd'];

test('login finds Qwen Code and connects it at user level: our hooks and server after theirs, nothing of theirs moved', async () => {
  const server = await startServer();
  const m = qwenMachine();
  try {
    const out = await login(server, m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/Qwen Code\s+connected\s+~\/\.qwen\/settings\.json/));
    assert.match(out.stdout, /refused once, with the warning as the reason, and the same edit again goes through/);
    assert.match(out.stdout, /Qwen Code reads its hooks as it starts/);
    assert.match(out.stdout, /runs these hooks from 0\.14\.0 on, and tells them the prompt you typed, which is what is reported, from 0\.21\.1 on/);

    const settings = json(m.at.settings);
    // theirs, as it was and where it was
    assert.deepEqual(Object.keys(settings), ['$version', 'security', 'model', 'hooks', 'mcpServers']);
    for (const key of ['$version', 'security', 'model']) assert.deepEqual(settings[key], THEIRS[key]);
    assert.deepEqual(settings.hooks.PreToolUse[0], THEIRS.hooks.PreToolUse[0], 'their hook first');
    assert.deepEqual(Object.keys(settings.mcpServers), ['github', 'agentmash']);
    assert.deepEqual(settings.mcpServers.github, THEIRS.mcpServers.github);
    assert.deepEqual(settings.mcpServers.agentmash, { command: 'node', args: [path.join(m.hookDir, 'mcp_server.mjs')] }, 'no trust: Qwen Code asks, as it would');

    // ours: one group per event, each hook named, its timeout in milliseconds Qwen Code reads as such on every version
    assert.deepEqual(Object.keys(settings.hooks), EVENTS);
    const ours = Object.fromEntries(EVENTS.map((e) => [e, settings.hooks[e].at(-1)]));
    assert.deepEqual(
      EVENTS.map((e) => [e, ours[e].matcher ?? null, ours[e].hooks.map((h) => [h.name, h.type, h.command, h.timeout])]),
      [
        ['PreToolUse', '^(edit|write_file|notebook_edit)$', [['agentmash-pre-edit', 'command', command(m, 'pre_edit'), 6000]]],
        ['PostToolUse', '^(edit|write_file|notebook_edit|run_shell_command)$', [['agentmash-post-edit', 'command', command(m, 'post_edit'), 5000]]],
        ['UserPromptSubmit', null, [['agentmash-prompt', 'command', command(m, 'prompt'), 5000]]],
        ['SessionStart', null, [['agentmash-session-start', 'command', command(m, 'session_start'), 6000]]],
        ['SessionEnd', null, [['agentmash-session-end', 'command', command(m, 'session_end'), 3000]]],
      ]
    );
    for (const group of Object.values(ours)) {
      assert.deepEqual(Object.keys(group).filter((k) => !['matcher', 'hooks'].includes(k)), [], 'no sequential, nothing else');
      for (const h of group.hooks) {
        assert.ok(h.timeout >= 1000, 'read as milliseconds before 0.23.4 and after');
        assert.equal(h.async, undefined, 'never async: a full async slot would drop a report');
        assert.doesNotMatch(h.command, /\d+\.\d+\.\d+|\$|bypass|trust|approve|allow/i, 'the same string from one version to the next');
      }
    }
    // what those commands run is there, with the dialect they answer in
    assert.ok(fs.existsSync(path.join(m.hookDir, 'agent_hook.mjs')));
    assert.ok(
      fs.readFileSync(path.join(m.hookDir, 'dialects', 'qwen.mjs')).equals(fs.readFileSync(path.join(CLI_DIR, '..', 'hooks', 'dialects', 'qwen.mjs'))),
      'the dialect from this checkout'
    );
    if (process.platform !== 'win32') assert.equal(mode(m.at.settings), 0o600, 'a file that holds their token stays private');
    // nothing else written into ~/.qwen but what the settings held before agentmash, as private as they are
    assert.deepEqual(fs.readdirSync(m.at.dir).sort(), ['settings.json', 'settings.json.before-agentmash']);
    assert.equal(fs.readFileSync(`${m.at.settings}.before-agentmash`, 'utf8'), `${JSON.stringify(THEIRS, null, 2)}\n`);
    if (process.platform !== 'win32') assert.equal(mode(`${m.at.settings}.before-agentmash`), 0o600, 'the copy holds their token too, so it is as private');
  } finally {
    await server.close();
  }
});

test('login again is already connected, byte for byte, and a hook the person put after ours stays before ours once ours is renewed', async () => {
  const server = await startServer();
  const m = qwenMachine();
  try {
    await login(server, m.env);
    const before = md5(m.at.settings);
    const again = await login(server, m.env);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Qwen Code\s+already connected/);
    assert.equal(md5(m.at.settings), before);

    // one of theirs, after ours, and ours out of date: theirs first, ours after
    const edited = json(m.at.settings);
    const mine = { matcher: '^write_file$', hooks: [{ type: 'command', command: './check.sh' }] };
    edited.hooks.PreToolUse.push(mine);
    edited.hooks.PreToolUse[1].hooks[0].timeout = 4000;
    fs.writeFileSync(m.at.settings, `${JSON.stringify(edited, null, 2)}\n`);
    const third = await login(server, m.env);
    assert.match(third.stdout, /Qwen Code\s+connected/);
    const pre = json(m.at.settings).hooks.PreToolUse;
    assert.deepEqual(pre.slice(0, 2), [THEIRS.hooks.PreToolUse[0], mine]);
    assert.equal(pre.length, 3);
    assert.equal(pre[2].hooks[0].timeout, 6000);

    // and logout takes ours out, and leaves both of theirs
    await run(['logout'], m.env);
    assert.deepEqual(json(m.at.settings).hooks, { PreToolUse: [THEIRS.hooks.PreToolUse[0], mine] });
  } finally {
    await server.close();
  }
});

test("logout takes out everything login wrote, and leaves the person's file byte for byte as it was, however they laid it out", async () => {
  const server = await startServer();
  try {
    const layouts = {
      'two spaces': `${JSON.stringify(THEIRS, null, 2)}\n`,
      'tabs, CRLF, a byte-order mark, no newline at the end': `\uFEFF${JSON.stringify(THEIRS, null, '\t').replace(/\n/g, '\r\n')}`,
      'one line': JSON.stringify({ $version: 4, ui: { theme: 'GitHub' } }),
      'four spaces, nothing of theirs in hooks or servers': `${JSON.stringify({ $version: 4, general: { vimMode: true } }, null, 4)}\n`,
    };
    for (const [layout, settings] of Object.entries(layouts)) {
      const m = qwenMachine({ settings });
      const before = md5(m.at.settings);
      const connected = await login(server, m.env);
      assert.match(connected.stdout, /Qwen Code\s+connected/, layout);
      assert.ok(runsOurs(fs.readFileSync(m.at.settings, 'utf8')), layout);
      const out = await run(['logout'], m.env);
      assert.equal(out.code, 0, out.stderr);
      assert.equal(md5(m.at.settings), before, layout);
      if (process.platform !== 'win32') assert.equal(mode(m.at.settings), 0o600, layout);
      assert.ok(!fs.existsSync(m.hookDir), 'nothing runs the scripts any more');
    }

    // no settings file yet: login makes one, at the version Qwen Code writes, private; logout takes it away again
    const bare = qwenMachine({ settings: null });
    await login(server, bare.env);
    const made = json(bare.at.settings);
    assert.equal(Object.keys(made)[0], '$version');
    assert.equal(made.$version, 4, 'so Qwen Code has nothing to rewrite as it starts');
    assert.deepEqual(Object.keys(made), ['$version', 'hooks', 'mcpServers']);
    if (process.platform !== 'win32') assert.equal(mode(bare.at.settings), 0o600);
    await run(['logout'], bare.env);
    assert.ok(!fs.existsSync(bare.at.settings));
    assert.ok(fs.existsSync(bare.at.dir), "Qwen Code's own folder stays");
  } finally {
    await server.close();
  }
});

test('tools lists Qwen Code by its version, and adds or removes it on its own', async () => {
  const m = qwenMachine();
  const list = await run(['tools'], m.env);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /qwen\s+Qwen Code\s+found · 0\.24\.7\s+not connected/);

  const add = await run(['tools', 'add', 'qwen'], m.env);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /Qwen Code\s+connected/);
  assert.match((await run(['tools'], m.env)).stdout, /qwen\s+Qwen Code\s+found · 0\.24\.7\s+connected/);

  const remove = await run(['tools', 'remove', 'qwen'], m.env);
  assert.equal(remove.code, 0, remove.stderr);
  assert.match(remove.stdout, /Qwen Code\s+disconnected/);
  assert.equal(fs.readFileSync(m.at.settings, 'utf8'), `${JSON.stringify(THEIRS, null, 2)}\n`);
  assert.match((await run(['tools'], m.env)).stdout, /qwen\s+Qwen Code\s+found · 0\.24\.7\s+not connected/);

  // found by its folder with no qwen on the path; not found with neither
  assert.match((await run(['tools'], qwenMachine({ cli: false }).env)).stdout, /qwen\s+Qwen Code\s+found\s+not connected/);
  assert.match((await run(['tools'], qwenMachine({ qwen: false, cli: false }).env)).stdout, /qwen\s+Qwen Code\s+not found/);
});

test("doctor says where Qwen Code's hooks are and that its server is registered, and when a script they run is gone", async () => {
  const server = await startServer();
  const m = qwenMachine();
  try {
    await login(server, m.env);
    const doctor = await run(['doctor'], m.env, m.home);
    assert.match(doctor.stdout, shownHere(/Qwen Code: hooks in ~\/\.qwen\/settings\.json \(5 events\) · MCP server registered/));
    assert.doesNotMatch(doctor.stdout, /Qwen Code[^\n]*approv/, 'Qwen Code asks nobody to approve a user hook');

    fs.rmSync(path.join(m.hookDir, 'dialects', 'qwen.mjs'));
    const silent = await run(['doctor'], m.env, m.home);
    assert.match(silent.stdout, /✗ Qwen Code: runs .*dialects[\\/]qwen\.mjs, which does not exist/, 'without its dialect every answer is nothing');
    assert.equal(silent.code, 1);

    fs.rmSync(path.join(m.hookDir, 'agent_hook.mjs'));
    assert.match((await run(['doctor'], m.env, m.home)).stdout, /✗ Qwen Code: runs .*agent_hook\.mjs, which does not exist — every call fails/);
  } finally {
    await server.close();
  }
});

test('a settings file login cannot read, or would lose comments from, is skipped and named; logout keeps the scripts a file it cannot read may still run', async () => {
  const server = await startServer();
  try {
    for (const [what, text, why] of [
      ['broken', '{ "$version": 4, ', shownHere(/~\/\.qwen\/settings\.json is not valid JSON — fix it, then run login again/)],
      ['a trailing comma, which Qwen Code does not read either', '{ "$version": 4, }', /is not valid JSON/],
      ['comments', '{\n  // my model\n  "model": { "name": "qwen3-coder-plus" }\n}\n', /has comments in it, which writing it back would lose — take them out, then run login again/],
      ['hooks that are no object', '{ "hooks": [] }', /has a "hooks" that is not an object — fix it, then run login again/],
    ]) {
      const m = qwenMachine({ settings: text });
      const out = await login(server, m.env);
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, new RegExp(`Qwen Code\\s+skipped — ${why.source.startsWith('~') ? '' : '.*'}${why.source}`), what);
      assert.equal(fs.readFileSync(m.at.settings, 'utf8'), text, `${what}: left exactly as it was`);
    }

    // a JSONC file is read as Qwen Code reads it: a // in a string is no comment
    const url = qwenMachine({ settings: '{ "proxy": "http://proxy.local//x" }\n' });
    assert.match((await login(server, url.env)).stdout, /Qwen Code\s+connected/);

    // a server of somebody else's called agentmash, and servers that are not an object: the hooks go in, the server does not, and that is said
    const taken = qwenMachine({ settings: JSON.stringify({ mcpServers: { agentmash: { command: 'docker', args: ['run', 'theirs'] } } }) });
    const said = await login(server, taken.env);
    assert.match(said.stdout, shownHere(/a server called agentmash is in ~\/\.qwen\/settings\.json already, and not ours: left as it is/));
    assert.deepEqual(json(taken.at.settings).mcpServers, { agentmash: { command: 'docker', args: ['run', 'theirs'] } });
    const odd = qwenMachine({ settings: JSON.stringify({ mcpServers: 'none' }) });
    assert.match((await login(server, odd.env)).stdout, /has an "mcpServers" that is not an object: the MCP server was not added/);
    assert.equal(json(odd.at.settings).mcpServers, 'none');

    // broken after login: logout names it, keeps the scripts it may still run, and signs out all the same
    const later = qwenMachine();
    await login(server, later.env);
    fs.writeFileSync(later.at.settings, fs.readFileSync(later.at.settings, 'utf8').replace(/\}\s*$/, ',}'));
    const out = await run(['logout'], later.env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/~\/\.qwen\/settings\.json is not valid JSON: agentmash is still in it/));
    assert.match(out.stdout, shownHere(/kept .*\.agentmash\/hooks/));
    assert.ok(fs.existsSync(path.join(later.hookDir, 'agent_hook.mjs')), 'what Qwen Code still runs is still there');
    assert.ok(!fs.existsSync(path.join(later.home, '.agentmash', 'user.json')));
  } finally {
    await server.close();
  }
});

test('a symlinked settings.json stays a link, and what it points at comes back byte for byte', POSIX, async () => {
  const server = await startServer();
  try {
    const m = qwenMachine();
    // ~/.qwen/settings.json as stow or chezmoi leave it: a link into the person's dotfiles
    const dotfiles = path.join(m.home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    const target = path.join(dotfiles, 'qwen-settings.json');
    fs.renameSync(m.at.settings, target);
    fs.symlinkSync(target, m.at.settings);
    const before = md5(target);

    await login(server, m.env);
    assert.ok(fs.lstatSync(m.at.settings).isSymbolicLink(), 'still the link');
    assert.ok(json(target).mcpServers.agentmash, 'ours went into what it points at');
    assert.equal(mode(target), 0o600);
    for (const dir of [m.at.dir, dotfiles]) assert.deepEqual(fs.readdirSync(dir).filter((f) => /tmp/.test(f)), [], `no temporary file left in ${dir}`);
    await run(['logout'], m.env);
    assert.ok(fs.lstatSync(m.at.settings).isSymbolicLink());
    assert.equal(md5(target), before, 'byte for byte');

    // a link to a file that held only what login wrote keeps pointing at a file Qwen Code reads
    const fresh = qwenMachine({ settings: null });
    const elsewhere = path.join(fresh.home, 'dotfiles-qwen.json');
    fs.symlinkSync(elsewhere, fresh.at.settings);
    await login(server, fresh.env);
    assert.ok(json(elsewhere).hooks);
    await run(['logout'], fresh.env);
    assert.ok(fs.lstatSync(fresh.at.settings).isSymbolicLink());
    assert.deepEqual(json(elsewhere), { $version: 4 });
  } finally {
    await server.close();
  }
});

test('QWEN_HOME moves the settings, from the environment or from the .env files Qwen Code reads it from; --skip qwen leaves Qwen Code as it is', async () => {
  const server = await startServer();
  try {
    const m = qwenMachine();
    const elsewhere = path.join(m.home, 'qwen-elsewhere');
    const env = { ...m.env, QWEN_HOME: elsewhere };
    const out = await login(server, env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/Qwen Code\s+connected\s+~\/qwen-elsewhere\/settings\.json/));
    assert.ok(json(path.join(elsewhere, 'settings.json')).hooks.PreToolUse);
    assert.equal(fs.readFileSync(m.at.settings, 'utf8'), `${JSON.stringify(THEIRS, null, 2)}\n`, '~/.qwen is not the one read');
    await run(['logout'], env);
    assert.ok(!fs.existsSync(path.join(elsewhere, 'settings.json')));

    // ~/.qwen/.env first, then ~/.env, as Qwen Code reads them before anything else; ~ is the home
    for (const [file, line, where] of [
      [['.qwen', '.env'], 'OPENAI_API_KEY=sk-x\nQWEN_HOME="~/from-qwen-env" # mine\n', 'from-qwen-env'],
      [['.env'], 'export QWEN_HOME=~/from-home-env\n', 'from-home-env'],
    ]) {
      const e = qwenMachine();
      fs.writeFileSync(path.join(e.home, ...file), line);
      const said = await login(server, e.env);
      assert.match(said.stdout, shownHere(new RegExp(`Qwen Code\\s+connected\\s+~/${where}/settings\\.json`)), where);
      assert.ok(fs.existsSync(path.join(e.home, where, 'settings.json')), where);
    }
    // the environment's, set even to nothing, is read before either file
    const empty = qwenMachine();
    fs.writeFileSync(path.join(empty.home, '.env'), 'QWEN_HOME=~/not-this\n');
    assert.match((await login(server, { ...empty.env, QWEN_HOME: '' })).stdout, shownHere(/Qwen Code\s+connected\s+~\/\.qwen\/settings\.json/));

    const skipped = qwenMachine();
    const before = md5(skipped.at.settings);
    const out2 = await login(server, skipped.env, ['--skip', 'qwen']);
    assert.match(out2.stdout, /Qwen Code\s+skipped — left out with --skip/);
    assert.equal(md5(skipped.at.settings), before);
  } finally {
    await server.close();
  }
});

test('hooks switched off in the settings are said on login, and a hooks folder with a $ in its path is never written into a command', POSIX, async () => {
  const server = await startServer();
  try {
    const off = qwenMachine({ settings: `${JSON.stringify({ ...THEIRS, disableAllHooks: true }, null, 2)}\n` });
    const out = await login(server, off.env);
    assert.match(out.stdout, shownHere(/hooks are switched off in ~\/\.qwen\/settings\.json \(disableAllHooks is true\): Qwen Code runs none of them/));
    assert.equal(json(off.at.settings).disableAllHooks, true, 'switched on by nobody but the person');
    // and inspect has it for doctor (QWEN_HOME is this process's, so set aside)
    const saved = process.env.QWEN_HOME;
    delete process.env.QWEN_HOME;
    try {
      assert.deepEqual(AGENTS.qwen.inspect({ home: off.home }).warnings, ['hooks are switched off in ~/.qwen/settings.json (disableAllHooks is true): Qwen Code runs none of them']);
    } finally {
      if (saved !== undefined) process.env.QWEN_HOME = saved;
    }

    // Qwen Code reads $VAR in its settings as a variable: such a path is refused, and said
    const m = qwenMachine();
    const dollar = path.join(m.home, 'a$HOME');
    fs.mkdirSync(dollar);
    const before = md5(m.at.settings);
    const add = await run(['tools', 'add', 'qwen'], { ...m.env, AGENTMASH_HOME: dollar });
    assert.match(add.stdout, /Qwen Code\s+skipped — .*has a \$, a quote or a backslash in its path/);
    assert.equal(md5(m.at.settings), before);
  } finally {
    await server.close();
  }
});

test('what login registers with Qwen Code is the same strings every time, with no version in them', POSIX, () => {
  const qwen = AGENTS.qwen;
  assert.deepEqual([qwen.id, qwen.name, qwen.env], ['qwen', 'Qwen Code', ['QWEN_HOME']]);
  assert.ok(qwen.order > AGENTS.devin.order, 'after the agents connected first');
  assert.equal(qwen.approvalHint, undefined, 'Qwen Code asks nobody to approve a user hook');
  const dir = '/home/someone/.agentmash/hooks';
  assert.deepEqual(qwen.hooks(dir), qwen.hooks(dir));
  assert.deepEqual(
    Object.values(qwen.hooks(dir)).map((groups) => groups[0].hooks[0].command),
    ['pre_edit', 'post_edit', 'prompt', 'session_start', 'session_end'].map(
      (event) => `node "/home/someone/.agentmash/hooks/agent_hook.mjs" ${event} --global --client qwen --dialect qwen`
    )
  );
  // what logout looks in before it takes the scripts away (QWEN_HOME is this process's, so set aside)
  const saved = process.env.QWEN_HOME;
  delete process.env.QWEN_HOME;
  try {
    assert.deepEqual(qwen.files({ home: '/home/nobody-here' }), { settings: '/home/nobody-here/.qwen/settings.json' });
  } finally {
    if (saved !== undefined) process.env.QWEN_HOME = saved;
  }
});
