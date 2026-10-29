// What the tests of the hooks as other agents run them share: running a hook
// script as an agent would, a room that records what it was asked, and a
// checkout with a home beside it, signed in or carrying a room of its own.
// Nothing here touches the real home: every machine is a temporary folder,
// and every room a server on a port of its own.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SLOWNESS, timed, within } from '../../tools/test-timing.mjs';

export const HOOKS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REF = 'rm_0123456789';
export const USER_TOKEN = 'amu_agentstokenagentstokenagent';
export const KEY = 'mash_agentsroomagentsroomagen';

/**
 * A time limit a test holds a hook to, stretched on a slow or shared machine
 * (tools/test-timing.mjs, which the server's and the CLI's tests share):
 * AGENTMASH_TEST_SLOWNESS multiplies it where it is set (CI sets it on our
 * own runner, which shares its cores with agentmash.dev), 2 on CI without
 * it, 1 anywhere else. It stretches only how long a test waits, never what a
 * hook is told, but for the room's budget below.
 */
export { SLOWNESS, timed, within };

/** This process's environment without anything of agentmash's or Claude Code's that would point a hook elsewhere. */
export const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTMASH_') && k !== 'CLAUDE_PROJECT_DIR')
);

/**
 * Run a script in `dir` (the hooks folder, by default) as an agent runs a
 * hook: `payload` on its stdin, as JSON unless it is a string. Resolves with
 * { code, stdout, stderr, elapsed }.
 */
export function runHook(script, payload, env, args = [], { dir = HOOKS_DIR } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(dir, script), ...args], {
      env: { ...baseEnv, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, elapsed: Date.now() - started }));
    child.stdin.on('error', () => {});
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

/** A teammate at work in src/models/user.ts a minute ago. */
export const HOLDER = {
  developer: 'alice',
  task_hint: 'add soft deletes',
  minutes_ago: 1,
  branch: 'feat/other',
  file_path: 'src/models/user.ts',
  change_summary: '+3/-1 lines',
};

/**
 * A room on a port of its own that records every request: /check answers
 * with `holders` (and `claims`) for the file asked about, or, with `hang`,
 * never; /events answers after `eventsDelayMs`.
 */
export function startServer({ holders = [HOLDER], claims = [], eventsDelayMs = 0, hang = false } = {}) {
  const requests = [];
  const hung = new Set();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      let parsed = null;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch {
        parsed = body;
      }
      requests.push({
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        room: req.headers['x-agentmash-room'],
        user: req.headers['x-agentmash-user'],
        source: req.headers['x-agentmash-developer-source'],
        body: parsed,
      });
      const send = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (url.pathname === '/api/lookup') return send(200, { room_ref: REF, developer: 'bob' });
      if (url.pathname === '/check') {
        if (hang) return hung.add(res);
        const file = url.searchParams.get('file_path');
        return send(200, {
          conflict: true,
          holders: holders.filter((h) => h.file_path === file),
          claims: claims.filter((c) => c.file_path === file),
        });
      }
      if (url.pathname === '/team') return send(200, { developers: [] });
      if (url.pathname === '/collisions') return send(200, { reconcile_mode: 'approve', collisions: [] });
      if (eventsDelayMs > 0) return setTimeout(() => send(201, { ok: true }), eventsDelayMs);
      return send(201, { ok: true });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () =>
          new Promise((r) => {
            for (const res of hung) res.destroy();
            server.closeAllConnections?.();
            server.close(r);
          }),
      })
    )
  );
}

/**
 * A checkout of acme/app on feat/login, and a home: signed in to `port` with
 * `npx agentmash login`, or, with `committed`, a checkout that carries a room
 * of its own (`npx agentmash init`) and a home that never signed in.
 */
export function machine(port, { committed = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-agents-home-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-agents-checkout-')));
  fs.mkdirSync(path.join(project, '.git'));
  fs.writeFileSync(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/feat/login\n');
  fs.writeFileSync(path.join(project, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/app.git\n');
  fs.mkdirSync(path.join(project, 'src', 'models'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'models', 'user.ts'), 'export interface User { id: string }\n');
  if (committed) {
    fs.mkdirSync(path.join(project, '.claude', 'agentmash'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.claude', 'agentmash', 'config.json'),
      JSON.stringify({ url: `http://127.0.0.1:${port}`, room: KEY, label: 'app' })
    );
  } else {
    fs.mkdirSync(path.join(home, '.agentmash'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.agentmash', 'user.json'),
      JSON.stringify({ url: `http://127.0.0.1:${port}`, token: USER_TOKEN, login: 'bob' })
    );
  }
  // No CLAUDE_PROJECT_DIR: no other agent sets it, and the hooks go by the payload's cwd.
  // On a slow machine the hooks' own budget for the room's answer (1500 ms)
  // stretches as the tests' limits do, or a room that answers in time there
  // reads as one that never did; a test that sets its own budget still wins.
  const budget = SLOWNESS > 1 ? { AGENTMASH_TIMEOUT_MS: String(within(1500)) } : {};
  return { env: { AGENTMASH_HOME: home, AGENTMASH_DEV: 'bob', ...budget }, project, home };
}

/** A session id no other test shares. */
export const session = () => `agents-${process.pid}-${Math.random().toString(36).slice(2)}`;

/**
 * The events the room got, once `count` of them have arrived (a background
 * report lands after its hook is gone), or whatever came by `timeoutMs`,
 * stretched on a slow machine (within).
 */
export async function eventsOf(server, count, timeoutMs = 4000) {
  const deadline = Date.now() + within(timeoutMs);
  for (;;) {
    const events = server.requests.filter((r) => r.path === '/events');
    if (events.length >= count || Date.now() > deadline) return events;
    await new Promise((r) => setTimeout(r, 25));
  }
}
