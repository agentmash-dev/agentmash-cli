// A secret pasted into a prompt, or written into a commit subject, stays on
// this machine: what goes to the room as the task hint has it masked as
// [hidden]. One list does it (SECRET_PATTERNS in lib.mjs), the lobby app's
// own and what it missed, and every pattern on it is held to an example here.
// The examples are put together from parts, so no scanner reads one as a key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as lib from '../lib.mjs';
import { eventsOf, machine, runHook, session, startServer } from './fixtures.mjs';

// a home of its own, for what lib.mjs keeps there, and git with no config but the repository's
process.env.AGENTMASH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-secrets-home-'));
const EMPTY_GITCONFIG = path.join(process.env.AGENTMASH_HOME, 'gitconfig');
fs.writeFileSync(EMPTY_GITCONFIG, '');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG, GIT_CONFIG_NOSYSTEM: '1' };

const { SECRET_PATTERNS, redactSecrets } = lib;

/** One made-up secret of each kind the list masks. */
const SECRETS = {
  'an OpenAI or Anthropic key': ['sk', '-proj-', 'A1b2C3d4E5f6G7h8I9j0'].join(''),
  'a GitHub token': ['ghp', '_', 'A'.repeat(36)].join(''),
  'a GitHub fine-grained token': ['github', '_pat_', '11ABCDEFG0', 'x'.repeat(30)].join(''),
  "an agentmash machine's sign-in": ['amu', '_', 'machinetokenmachinetokenxx'].join(''),
  'an agentmash room key': ['mash', '_', 'roomkeyroomkeyroomkey'].join(''),
  'an AWS access key id': ['AKIA', 'ABCDEFGHIJKLMNOP'].join(''),
  'a Google API key': ['AIza', 'Sy', 'B'.repeat(33)].join(''),
  'a Slack token': ['xoxb', '-', '123456789012-abcdefghij'].join(''),
  'a JWT': ['eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'abcdefghijklmnopqrstuv'].join(''),
  'a Stripe live key': ['sk', '_live_', '51H', 'c'.repeat(30)].join(''),
  'a Stripe restricted key': ['rk', '_live_', 'd'.repeat(30)].join(''),
  'a GitLab token': ['glpat', '-', 'abcdefghij0123456789'].join(''),
  'an npm token': ['npm', '_', 'e'.repeat(36)].join(''),
  'a bearer token': ['Bearer ', 'abc.def-ghi_jkl~mno+pqr/stu='].join(''),
  'a password': ['password', '=', 'hunter2hunter2'].join(''),
  'a password said with a colon': ['PASSWORD', ': ', 'correct-horse'].join(''),
  'a PEM private key': ['-----BEGIN ', 'RSA PRIVATE KEY-----\n', 'MIIEowIBAAKCAQEA\nqwerty\n', '-----END RSA PRIVATE KEY-----'].join(''),
  'a PEM certificate': ['-----BEGIN ', 'CERTIFICATE-----\n', 'MIIDdzCCAl+gAwIBAgIE\n', '-----END CERTIFICATE-----'].join(''),
};

test('each kind of secret is masked where it stands, and the words around it stay', () => {
  for (const [kind, secret] of Object.entries(SECRETS)) {
    assert.equal(redactSecrets(`deploy with ${secret} please`), 'deploy with [hidden] please', kind);
  }
});

test('every pattern on the list masks a secret of its own here', () => {
  for (const pattern of SECRET_PATTERNS) {
    assert.ok(pattern.global, `${pattern} masks every match, not the first`);
    const covered = Object.values(SECRETS).some((secret) => new RegExp(pattern.source, pattern.flags).test(secret));
    assert.ok(covered, `${pattern} has an example`);
  }
});

test('ordinary words that only start like a secret are left alone', () => {
  for (const text of [
    'add a Bearer token check to the auth header',
    'the password reset flow sends two emails',
    'a mash_up of the two lists',
    'npm_config_cache is read from the environment',
    'sk-learn is not a key',
    'set ghp_ as the prefix the scanner looks for',
    'the -----BEGIN line of a file',
  ]) {
    assert.equal(redactSecrets(text), text);
  }
});

test('a private key cut off before its end is masked to the end of the text', () => {
  const cut = `here it is ${['-----BEGIN ', 'OPENSSH PRIVATE KEY-----\n', 'b3BlbnNzaC1rZXktdjEAAAAA\n'].join('')}`;
  assert.equal(redactSecrets(cut), 'here it is [hidden]');
  assert.equal(redactSecrets(undefined), '');
});

test('the prompt the room hears, and the edits after it, have a pasted secret masked', async () => {
  const server = await startServer();
  const { env, project } = machine(server.port);
  const sessionId = session();
  const pasted = `use ${SECRETS['a Stripe live key']} and ${SECRETS['a GitHub token']} to\n${SECRETS['a PEM private key']}\nfix billing`;
  try {
    const res = await runHook('user_prompt_submit.mjs', { session_id: sessionId, cwd: project, hook_event_name: 'UserPromptSubmit', prompt: pasted }, env, ['--global']);
    assert.equal(res.code, 0, res.stderr);
    const [reported] = await eventsOf(server, 1);
    assert.equal(reported.body.event_type, 'prompt');
    assert.equal(reported.body.task_hint, 'use [hidden] and [hidden] to [hidden] fix billing');

    // what this session's edits carry is the prompt as kept, masked too
    await runHook(
      'post_tool_use.mjs',
      {
        session_id: sessionId,
        cwd: project,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: path.join(project, 'src', 'models', 'user.ts'), old_string: 'id', new_string: 'uid' },
      },
      env,
      ['--global']
    );
    const events = await eventsOf(server, 2);
    const edit = events.find((e) => e.body.event_type === 'edit');
    assert.ok(edit, JSON.stringify(events.map((e) => e.body)));
    assert.equal(edit.body.task_hint, 'use [hidden] and [hidden] to [hidden] fix billing');
    for (const e of events) {
      for (const secret of [SECRETS['a Stripe live key'], SECRETS['a GitHub token'], 'MIIEowIBAAKCAQEA']) {
        assert.ok(!JSON.stringify(e.body).includes(secret), 'no secret in any request');
      }
    }
  } finally {
    lib.clearSessionCache(sessionId);
    await server.close();
  }
});

test('a secret right where the prompt is cut is masked whole, not cut to a piece of itself', async () => {
  const server = await startServer();
  const { env, project } = machine(server.port);
  const sessionId = session();
  const token = SECRETS['a GitHub token'];
  // the token starts 10 characters before the 500 the room is sent
  const pasted = `${'x'.repeat(lib.PROMPT_CHARS - 10)} ${token}`;
  try {
    await runHook('user_prompt_submit.mjs', { session_id: sessionId, cwd: project, hook_event_name: 'UserPromptSubmit', prompt: pasted }, env, ['--global']);
    const [reported] = await eventsOf(server, 1);
    assert.ok(!reported.body.task_hint.includes('ghp_'), reported.body.task_hint.slice(-40));
    assert.ok(reported.body.task_hint.endsWith('[hidden]'), reported.body.task_hint.slice(-40));
  } finally {
    lib.clearSessionCache(sessionId);
    await server.close();
  }
});

test('a commit made in a session goes to the room with a secret in its subject masked', async () => {
  // reportCommits sends a commit's subject as the git client does (clients/git/post_commit.mjs)
  const server = await startServer();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-secret-commit-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'bob@example.com');
    git('config', 'user.name', 'bob');
    fs.writeFileSync(path.join(dir, 'billing.ts'), 'export const key = 1;\n');
    git('add', 'billing.ts');
    git('commit', '-q', '-m', `rotate ${SECRETS['a Stripe live key']} in billing`);
    const sha = git('rev-parse', 'HEAD');
    const config = { url: server.url, room: 'mash_x', shareHints: true, reportTimeoutMs: 2000 };
    assert.ok((await lib.reportCommits(config, dir, [sha], { developer: 'bob' })) > 0, 'the commit is reported');
    const events = await eventsOf(server, 2);
    assert.ok(events.length >= 2, JSON.stringify(events));
    for (const e of events) assert.equal(e.body.task_hint, 'rotate [hidden] in billing', e.body.event_type);
  } finally {
    await server.close();
  }
});
