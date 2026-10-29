// status, doctor and login know every coding agent on the machine, not
// Claude Code alone. Someone who signed in and connected only Codex was told
// "hooks are missing from Claude Code — run: npx agentmash login", and login
// again changed nothing; login ended on "restart any Claude Code session"
// whatever it had connected. What these pin: Claude Code not connected is a
// problem only where it is installed, or where nothing is connected at all;
// an agent found and not connected is named with the command that connects
// it; and login names what it connected, and what to restart. Every test runs
// in a home of its own (fixtures/machine.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { json, machine, run, runsOurs, shownHere, startServer, TOKEN } from './fixtures/machine.mjs';

/** A checkout of acme/app, which the fixture's server says is not connected to a room yet. */
function checkout() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-status-repo-')));
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

/** `m` signed in to `url`, as login leaves it, without connecting any agent. */
function signIn(m, url) {
  fs.mkdirSync(path.join(m.home, '.agentmash'), { recursive: true });
  fs.writeFileSync(path.join(m.home, '.agentmash', 'user.json'), JSON.stringify({ url, token: TOKEN, login: 'bob' }));
}

/** No Claude Code on the machine: no ~/.claude, and no `claude` on the tool path. */
const withoutClaude = (m) => fs.rmSync(path.join(m.home, '.claude'), { recursive: true, force: true });

/** What Codex writes in config.toml once the person approves each of ours in /hooks. */
function approveCodex(m) {
  const file = path.join(m.home, '.codex', 'hooks.json');
  let approvals = '';
  for (const [event, groups] of Object.entries(json(file).hooks)) {
    const label = event.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase());
    groups.forEach((group, g) => {
      if (!runsOurs(group)) return;
      group.hooks.forEach((_, h) => {
        // the key a TOML string, as Codex writes it: a Windows path's backslashes escaped
        approvals += `\n[hooks.state.${JSON.stringify(`${file}:${label}:${g}:${h}`)}]\ntrusted_hash = "sha256:${'a'.repeat(64)}"\n`;
      });
    });
  }
  fs.appendFileSync(path.join(m.home, '.codex', 'config.toml'), approvals);
}

test('a machine with Codex alone connected, and no Claude Code, is set up: login, status and doctor say Codex, and nothing is missing', async () => {
  const server = await startServer();
  const m = machine({ with: ['codex'], cursor: false, copilot: false });
  withoutClaude(m);
  const repo = checkout();
  try {
    const login = await run(['login', '--server', server.url, '--no-open', '--tools', 'codex'], m.env);
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, /Codex\s+connected/);
    assert.match(login.stdout, /restart any Codex session that is already open so it picks this up/);
    // the note under Codex's row, and again as the last thing to do
    assert.match(login.stdout, /open codex, type \/hooks, and approve agentmash: Codex runs no hook until you do/);
    assert.match(login.stdout, /open codex, type \/hooks, and approve agentmash: Codex runs none of its hooks until you do/);
    assert.doesNotMatch(login.stdout, /Claude Code/, 'nothing connected it, and nothing tells them to restart it');
    assert.ok(!fs.existsSync(path.join(m.home, '.claude')), 'and nothing of Claude Code was made');

    const status = await run(['status'], m.env, repo);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /✓ signed in as bob/);
    assert.match(status.stdout, /✓ coding agents connected: Codex\n/);
    assert.match(status.stdout, /! Codex: hooks not approved yet — open codex, type \/hooks, and approve agentmash/);
    assert.doesNotMatch(status.stdout, /Claude Code|✗|found here/);

    const doctor = await run(['doctor'], m.env, m.home);
    assert.equal(doctor.code, 0, doctor.stdout);
    assert.match(doctor.stdout, shownHere(/! Codex: hooks in ~\/\.codex\/hooks\.json \(6 events\), not approved yet/));
    assert.doesNotMatch(doctor.stdout, /Claude Code|✗/);
    assert.match(doctor.stdout, /This machine is signed in and its hooks are installed/);

    // approved in /hooks: status has nothing more to say about Codex, and login no longer asks
    approveCodex(m);
    const approved = await run(['status'], m.env, repo);
    assert.doesNotMatch(approved.stdout, /not approved/);
    const again = await run(['login', '--server', server.url, '--no-open', '--tools', 'codex'], m.env);
    assert.match(again.stdout, /Codex\s+already connected/);
    assert.match(again.stdout, /restart any Codex session that is already open/);
    assert.doesNotMatch(again.stdout, /approve agentmash/);
  } finally {
    await server.close();
  }
});

test('Claude Code installed and not connected is a problem, named with the command that connects it, and only that', async () => {
  const server = await startServer();
  // Claude Code is here by its settings folder (the fixture's ~/.claude), Codex by its command
  const m = machine({ with: ['codex'], cursor: false, copilot: false });
  const repo = checkout();
  try {
    const login = await run(['login', '--server', server.url, '--no-open', '--tools', 'codex'], m.env);
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, /restart any Codex session/);

    const status = await run(['status'], m.env, repo);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /✓ coding agents connected: Codex\n/);
    assert.match(status.stdout, /✗ Claude Code is on this machine and not connected — run: npx agentmash tools add claude/);
    assert.doesNotMatch(status.stdout, /found here/, 'its own line says what to run, once');

    const doctor = await run(['doctor'], m.env, m.home);
    assert.equal(doctor.code, 1);
    assert.match(doctor.stdout, /✗ Claude Code is on this machine and not connected — run: npx agentmash tools add claude/);
    assert.match(doctor.stdout, shownHere(/Codex: hooks in ~\/\.codex\/hooks\.json/), 'and the agent that is connected is checked as ever');
    assert.match(doctor.stdout, /1 problem\(s\) found/);

    // which is what puts it right, with no second sign-in
    assert.equal((await run(['tools', 'add', 'claude'], m.env)).code, 0);
    const fixed = await run(['status'], m.env, repo);
    assert.match(fixed.stdout, /✓ coding agents connected: Claude Code and Codex\n/);
    assert.doesNotMatch(fixed.stdout, /✗/);
    const healthy = await run(['doctor'], m.env, m.home);
    assert.equal(healthy.code, 0, healthy.stdout);
    assert.match(healthy.stdout, /✓ hooks installed in Claude Code/);
  } finally {
    await server.close();
  }
});

test('Claude Code found by its command alone counts as installed, as `tools` finds it', async () => {
  const server = await startServer();
  const m = machine({ with: ['codex', 'claude'], cursor: false, copilot: false });
  withoutClaude(m);
  try {
    await run(['login', '--server', server.url, '--no-open', '--tools', 'codex'], m.env);
    const status = await run(['status'], m.env, checkout());
    assert.match(status.stdout, /✗ Claude Code is on this machine and not connected — run: npx agentmash tools add claude/);
  } finally {
    await server.close();
  }
});

test('nothing connected is a problem whatever is installed, and every agent found is named with what connects it', async () => {
  const server = await startServer();
  try {
    // signed in, with Claude Code and Codex here and neither connected (logout and a hand-copied user.json, say)
    const m = machine({ with: ['codex'], cursor: false, copilot: false });
    signIn(m, server.url);
    const repo = checkout();
    const status = await run(['status'], m.env, repo);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /✗ no coding agent on this machine is connected, so nothing from it reaches a room — run: npx agentmash login/);
    assert.match(status.stdout, /· found here, not connected: Claude Code and Codex — npx agentmash tools add claude codex/);
    assert.doesNotMatch(status.stdout, /coding agents connected/);

    const doctor = await run(['doctor'], m.env, m.home);
    assert.equal(doctor.code, 1);
    assert.match(doctor.stdout, /✗ no coding agent on this machine is connected, so nothing from it reaches a room — run: npx agentmash login/);
    assert.match(doctor.stdout, /Codex is on this machine and not connected — npx agentmash tools add codex/);
    assert.doesNotMatch(doctor.stdout, /Claude Code is on this machine/, 'one line for what one command fixes');

    // and with no agent on the machine at all, there is nothing to name
    const bare = machine({ with: [], codex: false, cursor: false, copilot: false });
    withoutClaude(bare);
    signIn(bare, server.url);
    const empty = await run(['status'], bare.env, checkout());
    assert.match(empty.stdout, /✗ no coding agent on this machine is connected/);
    assert.doesNotMatch(empty.stdout, /found here/);
  } finally {
    await server.close();
  }
});

test('login names every agent it connected in what to restart, and one that runs Claude Code\'s hooks only when they are there', async () => {
  const server = await startServer();
  try {
    const m = machine({ with: ['codex', 'devin'] });
    const all = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(all.code, 0, all.stderr);
    assert.match(all.stdout, /restart any Claude Code, Codex, Cursor, GitHub Copilot or Devin session that is already open so it picks this up/);
    assert.match(all.stdout, /open codex, type \/hooks, and approve agentmash: Codex runs none of its hooks until you do/);
    // status says the same agents, Devin with them: it runs Claude Code's hooks, which are there
    const status = await run(['status'], m.env, checkout());
    assert.match(status.stdout, /✓ coding agents connected: Claude Code, Codex, Cursor, GitHub Copilot and Devin\n/);

    // Claude Code left out: Devin has nothing to run, so it is not one to restart, and status says what connects it
    const skipped = machine({ with: ['codex', 'devin'], cursor: false, copilot: false });
    withoutClaude(skipped);
    const some = await run(['login', '--server', server.url, '--no-open', '--skip', 'claude'], skipped.env);
    assert.equal(some.code, 0, some.stderr);
    assert.match(some.stdout, /restart any Codex session that is already open/);
    const without = await run(['status'], skipped.env, checkout());
    assert.match(without.stdout, /✓ coding agents connected: Codex\n/);
    assert.match(without.stdout, /· found here, not connected: Devin — npx agentmash tools add claude/);
    assert.doesNotMatch(without.stdout, /✗/, 'Claude Code is not installed: nothing is missing');

    // and nothing connected at all is said, not a line naming no one
    const none = machine({ with: [], codex: false, cursor: false, copilot: false });
    const nothing = await run(['login', '--server', server.url, '--no-open', '--skip', 'claude'], none.env);
    assert.equal(nothing.code, 0, nothing.stderr);
    assert.match(nothing.stdout, /! no coding agent was connected — npx agentmash tools lists them, and how to connect one/);
    assert.doesNotMatch(nothing.stdout, /restart any/);
  } finally {
    await server.close();
  }
});

test("a connected agent whose settings file is not valid JSON is told to fix that file, not to connect it again", async () => {
  const server = await startServer();
  const m = machine({ with: ['codex'], cursor: false, copilot: false });
  withoutClaude(m);
  const repo = checkout();
  try {
    const login = await run(['login', '--server', server.url, '--no-open', '--tools', 'codex'], m.env);
    assert.equal(login.code, 0, login.stderr);
    // the person breaks ~/.codex/hooks.json by hand: tools add would only answer "fix it"
    fs.writeFileSync(path.join(m.home, '.codex', 'hooks.json'), '{ "hooks": ');
    const status = await run(['status'], m.env, repo);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, shownHere(/✗ Codex: ~\/\.codex\/hooks\.json is not valid JSON, so Codex runs none of its hooks — fix it, then run: npx agentmash login/));
    assert.doesNotMatch(status.stdout, /found here, not connected|no coding agent on this machine is connected/);
  } finally {
    await server.close();
  }
});
