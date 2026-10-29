// `npx agentmash token`: personal API tokens, made, listed and revoked with
// this machine's sign-in. What these tests pin: the request each command
// sends to /api/v1/tokens (the sign-in as a Bearer token and nothing else),
// that the token is on stdout alone, that nothing is sent until every
// argument reads, that the sign-in never goes to a server other than the one
// that issued it, through --server or a redirect, and what each refusal
// tells the person to do.
//
// The server is a stand-in on port 0; every run has a home of its own.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expiresInDays, nameOf, parseTokenArgs, reposOf } from '../token.mjs';

const CLI_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MODULE = pathToFileURL(path.join(CLI_DIR, 'token.mjs')).href;
const CLI = path.join(CLI_DIR, 'agentmash.mjs');
const RUNNER = 'const m = await import(process.argv[1]); await m.cmdToken(process.argv.slice(2));';
const MACHINE = 'amu_machinetokenmachinetokenxx';
const SECRET = 'amp_c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0';

const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTMASH_') && k !== 'NO_COLOR'));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

/**
 * A server with /api/v1/tokens. `state` is the test's to change while it
 * runs: `tokens` what GET lists, `answer[route]` a { status, body, headers }
 * one route gives instead (route is 'create', 'list' or 'revoke').
 */
async function startServer() {
  const requests = [];
  const state = {
    tokens: [],
    answer: {},
    created: null,
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        authorization: req.headers.authorization,
        user: req.headers['x-agentmash-user'],
        room: req.headers['x-agentmash-room'],
        cookie: req.headers.cookie,
        contentType: req.headers['content-type'],
        body: body ? JSON.parse(body) : null,
      });
      const send = ({ status, body: payload, headers = {} }) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(payload === undefined ? '' : JSON.stringify(payload));
      };
      const route =
        url.pathname === '/api/v1/tokens' && req.method === 'POST'
          ? 'create'
          : url.pathname === '/api/v1/tokens' && req.method === 'GET'
            ? 'list'
            : url.pathname.startsWith('/api/v1/tokens/') && req.method === 'DELETE'
              ? 'revoke'
              : null;
      if (route && state.answer[route]) return send(state.answer[route]);
      if (route && req.headers.authorization !== `Bearer ${MACHINE}`) {
        return send({ status: 401, body: { error: 'sign in again', code: 'unauthorized', request_id: 'r' } });
      }
      if (route === 'create') {
        const asked = JSON.parse(body);
        const days = asked.expires_in_days === undefined ? 90 : asked.expires_in_days;
        state.created = {
          id: 'tok_0a1b2c3d',
          name: asked.name,
          scopes: asked.scopes ?? ['read', 'write'],
          repos: asked.repos ?? null,
          created_at: '2026-10-05T10:00:00.000Z',
          last_used: null,
          expires_at: days === null ? null : new Date(Date.parse('2026-10-05T10:00:00.000Z') + days * 86_400_000).toISOString(),
          token: SECRET,
        };
        return send({ status: 201, body: state.created });
      }
      if (route === 'list') return send({ status: 200, body: { tokens: state.tokens } });
      if (route === 'revoke') {
        const id = decodeURIComponent(url.pathname.slice('/api/v1/tokens/'.length));
        const known = state.tokens.find((t) => t.id === id);
        if (!known) return send({ status: 404, body: { error: 'no such token', code: 'not_found', request_id: 'r' } });
        return send({ status: 200, body: { revoked: true } });
      }
      return send({ status: 404, body: { error: 'no such route', code: 'not_found', request_id: 'r' } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}`, requests, state };
}

/** A home signed in to `url` (null: not signed in). */
function home(url) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-token-')));
  if (url) {
    fs.mkdirSync(path.join(dir, '.agentmash'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.agentmash', 'user.json'),
      JSON.stringify({ url, token: MACHINE, login: 'alice', created_at: '2026-10-01T00:00:00.000Z' })
    );
  }
  return dir;
}

function exec(argv, dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd: os.tmpdir(),
      env: { ...baseEnv, AGENTMASH_HOME: dir, HOME: dir, USERPROFILE: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: strip(stdout), stderr: strip(stderr) }));
  });
}

/** `npx agentmash token <args>`, as the commands table calls it. */
const token = (args, dir) => exec(['--input-type=module', '-e', RUNNER, MODULE, ...args], dir);

/** Whether agentmash.mjs's commands table has `name` yet (the registration is the integrator's). */
function registered(name) {
  const text = fs.readFileSync(CLI, 'utf8');
  const table = /\nconst commands = \{([\s\S]*?)\n\};/.exec(text)?.[1] ?? '';
  return new RegExp(`^\\s+'?${name}'?:`, 'm').test(table);
}

const LISTED = [
  {
    id: 'tok_11111111',
    name: 'ci-bot',
    scopes: ['read', 'write'],
    repos: ['acme/app'],
    created_at: '2026-09-01T00:00:00.000Z',
    last_used: '2026-10-04T12:00:00.000Z',
    expires_at: '2026-12-01T00:00:00.000Z',
  },
  {
    id: 'tok_22222222',
    name: 'laptop',
    scopes: ['read'],
    repos: null,
    created_at: '2026-09-02T00:00:00.000Z',
    last_used: null,
    expires_at: null,
  },
  {
    id: 'tok_33333333',
    name: 'old',
    scopes: ['read'],
    repos: null,
    created_at: '2025-01-01T00:00:00.000Z',
    last_used: null,
    expires_at: '2025-04-01T00:00:00.000Z',
  },
];

test('create sends the sign-in as a Bearer token, and puts the token alone on stdout', async () => {
  const server = await startServer();
  const dir = home(server.url);
  const res = await token(['create', '--name', 'ci-bot'], dir);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, `${SECRET}\n`);
  assert.equal(server.requests.length, 1);
  const [sent] = server.requests;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.path, '/api/v1/tokens');
  assert.equal(sent.search, '', 'nothing in the URL');
  assert.equal(sent.authorization, `Bearer ${MACHINE}`);
  assert.equal(sent.contentType, 'application/json');
  // the Bearer token is the only credential: no room, no legacy header, no cookie
  assert.equal(sent.user, undefined);
  assert.equal(sent.room, undefined);
  assert.equal(sent.cookie, undefined);
  // the server's own default expiry when none is asked for
  assert.deepEqual(sent.body, { name: 'ci-bot', scopes: ['read', 'write'] });
  assert.match(res.stderr, /made ci-bot\s+tok_0a1b2c3d/);
  assert.match(res.stderr, /read and write · every repository you can push to · expires 2027-01-03/);
  assert.match(res.stderr, /copy it now: it is shown this once/);
  assert.match(res.stderr, /Authorization: Bearer amp_…/);
  assert.match(res.stderr, /30 days old/);
  assert.ok(!res.stderr.includes(SECRET), 'the token is said once, on stdout');
});

test('create says read-only, repositories and expiry as the server takes them', async () => {
  const server = await startServer();
  const dir = home(server.url);
  let res = await token(['create', '--name', 'reader', '--read-only', '--repo', 'acme/app', '--repo', 'acme/api,Acme/Web.site,ACME/App', '--expires', '30d'], dir);
  assert.equal(res.code, 0, res.stderr);
  // the same repository in any case is one, as the server reads it
  assert.deepEqual(server.requests.at(-1).body, {
    name: 'reader',
    scopes: ['read'],
    repos: ['acme/app', 'acme/api', 'acme/web.site'],
    expires_in_days: 30,
  });
  assert.match(res.stderr, /read only · acme\/app, acme\/api, acme\/web\.site · expires 2026-11-04/);

  res = await token(['create', '--name=forever', '--expires=never'], dir);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(server.requests.at(-1).body, { name: 'forever', scopes: ['read', 'write'], expires_in_days: null });
  assert.match(res.stderr, /never expires/);

  res = await token(['create', '--name', 'year', '--expires', '365'], dir);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(server.requests.at(-1).body.expires_in_days, 365);
});

test('create with no --name names the token after the day, and never after this machine', async () => {
  const server = await startServer();
  const res = await token(['create'], home(server.url));
  assert.equal(res.code, 0, res.stderr);
  assert.match(server.requests[0].body.name, /^cli \d{4}-\d{2}-\d{2}$/);
  assert.equal(nameOf(undefined, new Date('2026-10-05T12:00:00Z')), 'cli 2026-10-05');
  // a computer's name is often its owner's: it stays on the machine, as the site says it does
  const host = os.hostname().split('.')[0];
  if (host && host !== 'cli') assert.ok(!JSON.stringify(server.requests).includes(host), `${host} went to the server`);
});

// The server and /keys take an emoji the zero-width joiner builds, and the
// CLI refused it, saying the name was not on one line.
test('a name with an emoji built by a joiner goes through, as the server takes it, and one that hides text still does not', async () => {
  const server = await startServer();
  const coder = `${String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb)} laptop`;
  assert.equal(nameOf(coder), coder);
  const res = await token(['create', '--name', coder], home(server.url));
  assert.equal(res.code, 0, res.stderr);
  assert.equal(server.requests.at(-1).body.name, coder);
  // a zero-width space, a right-to-left override and an isolate still hide or reorder what a list shows
  for (const hides of [0x200b, 0x202e, 0x2066]) {
    assert.throws(
      () => nameOf(`ci${String.fromCharCode(hides)}bot`),
      /--name takes 1 to 60 characters, on one line, and none that hide or reorder text/,
      hides.toString(16)
    );
  }
});

test('create --json prints the server\'s answer, token and all, on stdout', async () => {
  const server = await startServer();
  const res = await token(['create', '--name', 'ci', '--json'], home(server.url));
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), server.state.created);
  assert.equal(res.stderr, '');
});

test('nothing is sent until every argument reads', async () => {
  const server = await startServer();
  const dir = home(server.url);
  const cases = [
    [['create', '--expires', '0'], /--expires takes days from 1 to 365/],
    [['create', '--expires', '366d'], /--expires takes days from 1 to 365/],
    [['create', '--expires', 'soon'], /--expires takes days from 1 to 365/],
    [['create', '--expires', '1y'], /--expires takes days/],
    [['create', '--repo', 'acme'], /--repo takes a repository as owner\/name, not "acme"/],
    [['create', '--repo', 'https://github.com/acme/app'], /--repo takes a repository as owner\/name/],
    [['create', '--repo', 'acme/app/x'], /--repo takes a repository/],
    [['create', '--name', ''], /--name takes 1 to 60 characters/],
    [['create', '--name', 'x'.repeat(61)], /--name takes 1 to 60 characters/],
    [['create', '--name', 'two\nlines'], /--name takes 1 to 60 characters, on one line/],
    // a character that reorders text when the list shows it
    [['create', '--name', 'ci\u202ebot'], /--name takes 1 to 60 characters/],
    [['create', '--repo', Array.from({ length: 51 }, (_, i) => `acme/r${i}`).join(',')], /names 51 repositories: a token is held to 50 at most/],
    [['create', '--name', 'a', '--name', 'b'], /--name is given twice/],
    [['create', '--name'], /--name needs a value/],
    [['create', '--read-only=yes'], /--read-only takes no value/],
    [['create', '--scopes', 'all'], /unknown option --scopes/],
    [['create', 'extra'], /unexpected "extra"/],
    [['list', '--read-only'], /are for token create/],
    [['revoke'], /say which token/],
    [['rotate'], /unknown token command: rotate/],
  ];
  for (const [args, said] of cases) {
    const res = await token(args, dir);
    assert.equal(res.code, 1, args.join(' '));
    assert.equal(res.stdout, '', args.join(' '));
    assert.match(res.stderr, said, args.join(' '));
  }
  assert.equal(server.requests.length, 0);
});

test('a machine that is not signed in is told to sign in, and nothing is sent', async () => {
  const server = await startServer();
  const res = await token(['create', '--name', 'ci'], home(null));
  assert.equal(res.code, 1);
  assert.match(res.stderr, /this machine is not signed in — run npx agentmash login first/);
  assert.equal(server.requests.length, 0);
});

test('the sign-in never goes to a server other than the one that issued it', async () => {
  const signedIn = await startServer();
  const elsewhere = await startServer();
  const dir = home(signedIn.url);
  const res = await token(['list', '--server', elsewhere.url], dir);
  assert.equal(res.code, 1);
  assert.match(res.stderr, new RegExp(`signed in to ${signedIn.url.replace(/\./g, '\\.')}, not ${elsewhere.url.replace(/\./g, '\\.')}`));
  assert.match(res.stderr, /npx agentmash login --server/);
  assert.equal(elsewhere.requests.length, 0);
  assert.equal(signedIn.requests.length, 0);

  // naming the server it is signed in to is fine, trailing slash or not
  const same = await token(['list', '--server', `${signedIn.url}/`], dir);
  assert.equal(same.code, 0, same.stderr);
  assert.equal(signedIn.requests.length, 1);
});

test('a redirect is not followed with the sign-in', async () => {
  const signedIn = await startServer();
  const elsewhere = await startServer();
  signedIn.state.answer.list = { status: 307, body: {}, headers: { location: `${elsewhere.url}/api/v1/tokens` } };
  const res = await token(['list'], home(signedIn.url));
  assert.equal(res.code, 1);
  assert.match(res.stderr, /sent this request on to .*\(HTTP 307\); agentmash does not send your sign-in after it/);
  assert.equal(elsewhere.requests.length, 0);
});

test('list shows each token, never a secret, and --json the server\'s list', async () => {
  const server = await startServer();
  server.state.tokens = LISTED;
  const dir = home(server.url);
  const res = await token(['list'], dir);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(server.requests[0].method, 'GET');
  assert.equal(server.requests[0].authorization, `Bearer ${MACHINE}`);
  assert.match(res.stdout, /agentmash tokens\s+alice · http:\/\/127\.0\.0\.1:\d+/);
  const line = (id) => res.stdout.split('\n').find((l) => l.includes(id)) ?? '';
  assert.match(line('tok_11111111'), /ci-bot\s+read and write\s+acme\/app\s+last used 2026-10-04\s+expires 2026-12-01$/);
  assert.match(line('tok_22222222'), /laptop\s+read only\s+all repositories\s+never used\s+never expires$/);
  assert.match(line('tok_33333333'), /expired 2025-04-01$/);
  assert.match(res.stdout, /revoke one: npx agentmash token revoke <id>/);

  const json = await token(['list', '--json'], dir);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { tokens: LISTED });
});

test('an empty list says how to make one', async () => {
  const server = await startServer();
  const res = await token(['list'], home(server.url));
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /none yet — make one: npx agentmash token create --name <name>/);
});

test('what a server sends is printed without its escape sequences', async () => {
  const server = await startServer();
  server.state.tokens = [{ ...LISTED[1], name: 'evil\u001b]0;pwned\u0007name' }];
  const res = await token(['list'], home(server.url));
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!res.stdout.includes('\u001b'), 'no escape reaches the terminal');
  assert.match(res.stdout, /evil\]0;pwnedname/);
});

test('revoke by id deletes that token', async () => {
  const server = await startServer();
  server.state.tokens = LISTED;
  const res = await token(['revoke', 'tok_22222222'], home(server.url));
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(
    server.requests.map((r) => [r.method, r.path, r.authorization]),
    [['DELETE', '/api/v1/tokens/tok_22222222', `Bearer ${MACHINE}`]]
  );
  assert.match(res.stdout, /revoked tok_22222222: it opens nothing from now on/);
});

test('revoke by name finds the one token by that name, and refuses two', async () => {
  const server = await startServer();
  server.state.tokens = LISTED;
  const dir = home(server.url);
  let res = await token(['revoke', 'laptop', '--json'], dir);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), { id: 'tok_22222222', revoked: true });
  assert.deepEqual(
    server.requests.map((r) => [r.method, r.path]),
    [
      ['GET', '/api/v1/tokens'],
      ['DELETE', '/api/v1/tokens/tok_22222222'],
    ]
  );

  server.requests.length = 0;
  server.state.tokens = [...LISTED, { ...LISTED[1], id: 'tok_44444444' }];
  res = await token(['revoke', 'laptop'], dir);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /2 tokens are named "laptop": revoke one by its id \(tok_22222222, tok_44444444\)/);
  assert.ok(server.requests.every((r) => r.method !== 'DELETE'));

  res = await token(['revoke', 'nobody'], dir);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /no token is named "nobody"/);
  assert.ok(server.requests.every((r) => r.method !== 'DELETE'));
});

test('revoking a token the account does not have says so', async () => {
  const server = await startServer();
  server.state.tokens = LISTED;
  const res = await token(['revoke', 'tok_99999999'], home(server.url));
  assert.equal(res.code, 1);
  assert.match(res.stderr, /no token tok_99999999 on this account/);
});

test('each refusal says what to do', async () => {
  const cases = [
    [{ status: 401, body: { error: 'sign in again', code: 'reauth', request_id: 'r' } }, /GitHub has to say again what you can push to.*npx agentmash login/],
    [{ status: 401, body: { error: 'unknown token', code: 'invalid_token', request_id: 'r' } }, /sign-in has expired or was revoked — run: npx agentmash login/],
    [{ status: 403, body: { error: 'only a machine sign-in can make tokens', code: 'forbidden', request_id: 'r' } }, /only a machine sign-in can make tokens \(forbidden\)/],
    [
      { status: 409, body: { error: '25 API tokens already work for alice: revoke one first (npx agentmash token revoke <id>)', code: 'token_limit', request_id: 'r' } },
      /25 API tokens already work for alice: revoke one first \(npx agentmash token revoke <id>\) — npx agentmash token list shows them/,
    ],
    [
      { status: 429, body: { error: 'at most 10 API tokens an hour; try again in 2 minutes', code: 'rate_limited', request_id: 'r' }, headers: { 'retry-after': '120' } },
      /at most 10 API tokens an hour; try again in 2 minutes\n/,
    ],
    [{ status: 429, body: undefined, headers: { 'retry-after': '120' } }, /too many requests — try again in 120s/],
    [{ status: 401, body: { error: 'sign in on this machine', code: 'signed_out', request_id: 'r' } }, /sign-in has expired or was revoked — run: npx agentmash login/],
    // a server from before /api/v1, or before tokens: our 404, and Fastify's own
    [{ status: 404, body: { error: 'no such route', statusCode: 404 } }, /has no API tokens: it is older than this CLI/],
    [{ status: 404, body: { statusCode: 404, error: 'Not Found', message: 'Route POST:/api/v1/tokens not found' } }, /older than this CLI/],
    [{ status: 502, body: undefined }, /answered HTTP 502/],
  ];
  for (const [answer, said] of cases) {
    const server = await startServer();
    server.state.answer.create = answer;
    const res = await token(['create', '--name', 'ci'], home(server.url));
    assert.equal(res.code, 1, String(said));
    assert.equal(res.stdout, '', String(said));
    assert.match(res.stderr, said);
  }
});

test('a server that is not there is named', async () => {
  const server = await startServer();
  const url = server.url;
  await new Promise((r) => servers.pop().close(r));
  const res = await token(['list'], home(url));
  assert.equal(res.code, 1);
  assert.match(res.stderr, new RegExp(`could not reach ${url.replace(/\./g, '\\.')}`));
});

test('the arguments read as typed', () => {
  assert.deepEqual(parseTokenArgs(['create', '--read-only', '--repo', 'a/b', '--repo=c/d, e/f', '--json']), {
    _: ['create'],
    repos: ['a/b', 'c/d', 'e/f'],
    readOnly: true,
    json: true,
  });
  assert.equal(expiresInDays(undefined), undefined);
  assert.equal(expiresInDays('never'), null);
  assert.equal(expiresInDays('NEVER'), null);
  assert.equal(expiresInDays('90d'), 90);
  assert.equal(expiresInDays('7'), 7);
  assert.throws(() => expiresInDays('-1'));
  assert.throws(() => expiresInDays('1.5'));
  assert.equal(reposOf([]), null);
  assert.deepEqual(reposOf(['a/b', 'a/b']), ['a/b']);
});

test('no action, or --help, is the usage', async () => {
  for (const args of [[], ['--help']]) {
    const res = await token(args, home(null));
    assert.equal(res.code, 0);
    assert.match(res.stdout, /npx agentmash token create/);
    assert.match(res.stdout, /npx agentmash token revoke <tok_…\|name>/);
  }
});

test('through agentmash.mjs, once the commands table has it, create works the same', { skip: !registered('token') && 'token is not in the commands table yet' }, async () => {
  const server = await startServer();
  const res = await exec([CLI, 'token', 'create', '--read-only', '--name', 'ci', '--repo', 'acme/app', '--repo', 'acme/api'], home(server.url));
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, `${SECRET}\n`);
  assert.deepEqual(server.requests[0].body, { name: 'ci', scopes: ['read'], repos: ['acme/app', 'acme/api'] });
});
