// Who the hooks say this machine is. A machine signed in with `npx agentmash
// login` reported its git email, or its computer's user name when git gave
// none (an agent working outside the repository, a git slow to start on
// Windows), so one person showed up in a room under two or three names, each
// a seat and each the others' teammate. What these tests pin: AGENTMASH_DEV
// first, then the GitHub login this machine is signed in as for the room's
// server, then git's email, asked where git would commit from, and read from
// git's own files when git cannot answer; the computer's user name only when
// there is no email at all.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as lib from '../lib.mjs';

const scratch = (name) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `agentmash-identity-${name}-`)));

// Nobody's own setup: a home of its own for the sign-in, and git configs of
// the test's own, so git answers from what is made below and nothing else.
const saved = Object.fromEntries(
  ['AGENTMASH_HOME', 'AGENTMASH_DEV', 'AGENTMASH_URL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'PATH'].map((k) => [k, process.env[k]])
);
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
process.env.AGENTMASH_HOME = scratch('home');
delete process.env.AGENTMASH_DEV;
delete process.env.AGENTMASH_URL;
const GLOBAL = path.join(scratch('git'), 'gitconfig');
fs.writeFileSync(GLOBAL, '');
process.env.GIT_CONFIG_GLOBAL = GLOBAL;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const SERVER = 'https://agentmash.example';

/** A repository installed with `init`, whose own git config says who commits. */
function repository(email = 'dana@example.com') {
  const dir = scratch('repo');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (email) execFileSync('git', ['config', 'user.email', email], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.claude', 'agentmash'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'agentmash', 'config.json'), JSON.stringify({ url: SERVER, room: 'mash_identitytestidentity' }));
  return dir;
}

function signIn(url, login) {
  fs.mkdirSync(path.join(process.env.AGENTMASH_HOME, '.agentmash'), { recursive: true });
  fs.writeFileSync(path.join(process.env.AGENTMASH_HOME, '.agentmash', 'user.json'), JSON.stringify({ url, token: 'amu_identitytestidentitytest', login }));
}

function signOut() {
  fs.rmSync(path.join(process.env.AGENTMASH_HOME, '.agentmash', 'user.json'), { force: true });
}

test('signed in for the room’s server, the hooks report as the GitHub login; AGENTMASH_DEV still wins', () => {
  const repo = repository();
  try {
    const config = lib.loadConfig(repo);
    assert.equal(lib.getDeveloper(config, repo), 'dana@example.com', 'not signed in: git’s email');

    signIn(`${SERVER}/`, 'Dana-GH');
    assert.equal(lib.signedInLogin(config), 'dana-gh');
    assert.equal(lib.getDeveloper(config, repo), 'dana-gh', 'the login, as the server stores it');
    assert.equal(lib.getDeveloper(lib.withSignIn(config), repo), 'dana-gh', 'and as the hooks run it, with the sign-in beside the key');

    process.env.AGENTMASH_DEV = 'erin';
    assert.equal(lib.getDeveloper(lib.loadConfig(repo), repo), 'erin', 'two terminals on one machine can still be two people');
    delete process.env.AGENTMASH_DEV;

    // a sign-in for another server says nothing about who reports to this one
    signIn('https://elsewhere.example', 'dana-gh');
    assert.equal(lib.signedInLogin(config), '');
    assert.equal(lib.getDeveloper(config, repo), 'dana@example.com');

    // and a login that is not one is not used
    signIn(SERVER, 'not a login');
    assert.equal(lib.getDeveloper(config, repo), 'dana@example.com');
  } finally {
    signOut();
  }
});

test('an agent working outside the repository still reports as the person the repository knows, not as the computer', () => {
  const repo = repository('only-here@example.com');
  const outside = scratch('outside');
  const config = lib.loadConfig(repo);
  assert.equal(config.projectDir, repo);
  assert.equal(lib.getDeveloper(config, outside), 'only-here@example.com', 'from the repository root, not the folder the agent is in');
  assert.equal(lib.getDeveloper(config, path.join(repo, 'gone', 'away')), 'only-here@example.com', 'a folder that is gone');
  // and a checkout the agent is in is asked first, as git would commit from it
  const other = repository('other@example.com');
  assert.equal(lib.getDeveloper(config, other), 'other@example.com');
});

test('a git that cannot answer is read from its own files, so a slow start is never the computer’s user name', () => {
  const repo = repository('local@example.com');
  const bare = repository('');
  const config = lib.loadConfig(repo);
  const path0 = process.env.PATH;
  process.env.PATH = scratch('no-git');
  try {
    assert.equal(lib.getDeveloper(config, repo), 'local@example.com', 'this checkout’s own config');
    // the global one when the checkout says nothing, a subsection and a comment aside
    fs.writeFileSync(GLOBAL, '[user "work"]\n\temail = wrong@example.com\n[user]\n\tname = Dana\n\temail = "global@example.com" ; the one\n');
    assert.equal(lib.getDeveloper(lib.loadConfig(bare), bare), 'global@example.com');
  } finally {
    process.env.PATH = path0;
    fs.writeFileSync(GLOBAL, '');
  }
});

test('the computer’s user name only when there is no login and no email at all', () => {
  const bare = repository('');
  assert.equal(lib.getDeveloper(lib.loadConfig(bare), bare), os.userInfo().username);
});

test('AGENTMASH_DEV says so on every request, so a server keeps the name beside a sign-in, and nothing else does', async () => {
  const http = await import('node:http');
  const heard = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      heard.push(req.headers['x-agentmash-developer-source'] ?? null);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const repo = repository();
    process.env.AGENTMASH_DEV = 'erin';
    const set = lib.loadConfig(repo);
    delete process.env.AGENTMASH_DEV;
    const unset = lib.loadConfig(repo);
    assert.equal(set.dev, 'erin');
    for (const config of [set, unset]) {
      await lib.httpJson('GET', `${url}/check`, { room: config.room, user: 'amu_x', dev: config.dev });
      await lib.reportEvent({ ...config, url }, { developer: lib.getDeveloper(config, repo), session_id: 's', event_type: 'edit' });
    }
    assert.deepEqual(heard, ['env', 'env', null, null]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
