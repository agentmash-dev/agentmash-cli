// A server that stopped answering: after two checks in a row that waited out
// their budget for nothing, the check before an edit is not made for 15 s,
// then one hook asks again, and each wait after doubles that, up to a minute
// (lib.checkBreaker, and what it keeps in ~/.agentmash/health). Strict mode
// checks every edit and keeps nothing. The rules are asked of lib.mjs directly, and the
// hook is run as an agent runs it, against a room each test can hang, bring
// back or take down. Every test is a machine of its own: a home in a
// temporary folder, where the file is kept.
//
// Nothing here waits a minute. A minute passes by moving the times in the
// machine's file back (letPass): the hook is told nothing about the time,
// what it left only looks that much older.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  CHECK_BREAKER_FAILS,
  CHECK_BREAKER_FIRST_SKIP_MS,
  CHECK_BREAKER_SKIP_MS,
  CHECK_WAIT_KEPT_MS,
  checkBreaker,
  checkBreakerSkipMs,
  checkHealthPath,
  clearCheckHealth,
  readCheckHealth,
  recordCheckWait,
  writeSessionCache,
} from '../lib.mjs';
import { HOLDER, HOOKS_DIR, KEY, baseEnv, runHook, within } from './fixtures.mjs';
import { tempDir } from './tmp.mjs';

// This process asks lib.mjs directly too, and a breaker that was asking when
// a process ends keeps its wait as it goes: so the process has a home of its
// own as well, and nothing here can reach the real ~/.agentmash.
process.env.AGENTMASH_HOME = tempDir('agentmash-breaker-own-home-');

/** The budget a hook is given for a room that will not answer: short, so a test's two waits are a second, not three. */
const SHORT_MS = 400;

let counter = 0;
const session = () => `breaker-${process.pid}-${++counter}`;

/** A machine: a home of its own and a checkout with the file a teammate holds. */
function machine() {
  const home = tempDir('agentmash-breaker-home-');
  const project = fs.realpathSync(tempDir('agentmash-breaker-checkout-'));
  fs.mkdirSync(path.join(project, 'src', 'models'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'models', 'user.ts'), 'export interface User { id: string }\n');
  return { home, project };
}

/**
 * A room that answers /check with a teammate at work in the file, until it
 * is told otherwise: `mode` 'hang' holds every request and never answers,
 * 'error' answers 500, 'answer' is the room again. `checks` is every /check
 * that reached it.
 */
function startRoom(mode = 'answer') {
  const checks = [];
  const held = new Set();
  const room = { mode };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/check') checks.push(Object.fromEntries(url.searchParams));
      if (room.mode === 'hang') return held.add(res);
      res.writeHead(room.mode === 'error' ? 500 : 200, { 'content-type': 'application/json' });
      if (room.mode === 'error') return res.end(JSON.stringify({ error: 'the room is not well' }));
      res.end(JSON.stringify(url.pathname === '/check' ? { conflict: true, holders: [HOLDER], claims: [] } : { ok: true }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(
        Object.assign(room, {
          url: `http://127.0.0.1:${server.address().port}`,
          checks,
          close: () =>
            new Promise((r) => {
              for (const res of held) res.destroy();
              server.closeAllConnections?.();
              server.close(r);
            }),
        })
      )
    )
  );
}

/** One edit of the held file on `m`, in a session of its own unless given one, with `budgetMs` for the room. */
function edit(m, url, { budgetMs = within(1500), sessionId = session(), env = {} } = {}) {
  return runHook(
    'pre_tool_use.mjs',
    {
      session_id: sessionId,
      cwd: m.project,
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(m.project, 'src', 'models', 'user.ts'), old_string: 'a', new_string: 'b' },
    },
    {
      CLAUDE_PROJECT_DIR: m.project,
      AGENTMASH_HOME: m.home,
      AGENTMASH_URL: url,
      AGENTMASH_ROOM: KEY,
      AGENTMASH_DEV: 'bob',
      AGENTMASH_TIMEOUT_MS: String(budgetMs),
      ...env,
    }
  );
}

/** The file `home`'s machine keeps about `url`'s server, wherever the test process's own home is. */
function healthFile(home, url) {
  return atHome(home, () => checkHealthPath(url));
}

/** What `home`'s machine holds against `url`'s server, as the next hook there reads it. */
function held(home, url) {
  return atHome(home, () => readCheckHealth(url));
}

/** `run` with this process's AGENTMASH_HOME set to `home`, as a hook on that machine has it. */
function atHome(home, run) {
  const before = process.env.AGENTMASH_HOME;
  process.env.AGENTMASH_HOME = home;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.AGENTMASH_HOME;
    else process.env.AGENTMASH_HOME = before;
  }
}

/** Let `ms` pass on `home`'s machine: the times in its file about `url`'s server move back by that much. */
function letPass(home, url, ms) {
  const file = healthFile(home, url);
  const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['at', 'probe']) if (Number.isFinite(kept[key])) kept[key] -= ms;
  fs.writeFileSync(file, JSON.stringify(kept));
}

const silent = (result, what) => {
  assert.equal(result.code, 0, `${what}: exit 0`);
  assert.equal(result.stdout, '', `${what}: nothing said`);
  assert.equal(result.stderr, '', `${what}: nothing on stderr`);
};

// ── the rules, asked of lib.mjs ─────────────────────────────────────────────

test('nothing is kept about a server that answers: no file before, and none after its reply', () => {
  const { home } = machine();
  const url = 'http://room.example:8787';
  atHome(home, () => {
    assert.equal(readCheckHealth(url), null);
    const breaker = checkBreaker(url, 1500);
    assert.equal(breaker.skip, false);
    breaker.asking();
    breaker.heard({ status: 200, json: { conflict: false } });
    breaker.settle();
    assert.equal(readCheckHealth(url), null);
  });
  assert.ok(!fs.existsSync(path.join(home, '.agentmash')), 'not even the folder is made for a server that answers');
});

test('a check of a server that answers costs one look for a file that is not there, and touches nothing else', () => {
  // The hook's own code, with every synchronous call it makes to the file
  // system written down: what the check before an edit pays, on an ordinary
  // day, for a machine that can remember a hung server.
  const { home } = machine();
  const url = 'http://room.example:8787';
  const probe = path.join(tempDir('agentmash-breaker-probe-'), 'probe.mjs');
  fs.writeFileSync(
    probe,
    `import fs from 'node:fs';
const calls = [];
for (const [name, fn] of Object.entries(fs)) {
  if (typeof fn !== 'function' || !name.endsWith('Sync')) continue;
  fs[name] = function (...args) {
    calls.push([name, String(args[0])]);
    return fn.apply(this, args);
  };
}
const [libUrl, url] = process.argv.slice(2);
const lib = await import(libUrl);
const from = calls.length;
const breaker = lib.checkBreaker(url, 1500);
breaker.asking();
breaker.heard({ status: 200, json: { conflict: false, holders: [] } });
breaker.settle();
process.stdout.write(JSON.stringify({ skip: breaker.skip, calls: calls.slice(from) }));
`
  );
  const out = execFileSync(process.execPath, [probe, pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href, url], { env: { ...baseEnv, AGENTMASH_HOME: home } });
  const ran = JSON.parse(out.toString());
  assert.equal(ran.skip, false);
  assert.deepEqual(ran.calls, [['statSync', healthFile(home, url)]], 'one stat, of a file that is not there');
  assert.ok(!fs.existsSync(path.join(home, '.agentmash')), 'and nothing is made');
});

test('two waits in a row stop the checks for a minute, and a wait that began before the last one ended is the same silence', () => {
  const { home } = machine();
  const url = 'http://room.example:8787';
  atHome(home, () => {
    const t = Date.now() - 10_000;
    recordCheckWait(url, t, t + 1500);
    assert.deepEqual(readCheckHealth(url), { server: url, fails: 1, at: t + 1500, probe: 0 });
    assert.equal(checkBreaker(url, 1500).skip, false, 'one wait is not held against it');

    // a hook that ran beside the first, and timed out a moment after it
    recordCheckWait(url, t + 20, t + 1520);
    assert.deepEqual(readCheckHealth(url), { server: url, fails: 1, at: t + 1500, probe: 0 }, 'began before the first ended: one silence, heard twice, and kept as it was');
    assert.equal(checkBreaker(url, 1500).skip, false);
    // and a second agent's, begun while the first was still waiting and ended well after it
    recordCheckWait(url, t + 1000, t + 2500);
    assert.equal(readCheckHealth(url).fails, 1);

    // the next edit's check, begun after the first silence had ended, though the second agent's was still waiting:
    // agents whose checks overlap one after another, with never a moment between them, still come to a second wait
    recordCheckWait(url, t + 1600, t + 3100);
    assert.deepEqual(readCheckHealth(url), { server: url, fails: CHECK_BREAKER_FAILS, at: t + 3100, probe: 0 });
    assert.equal(checkBreaker(url, 1500).skip, true, 'two in a row: not asked again for now');
    // a check still out when the second wait was kept adds nothing to it, and does not move its time
    recordCheckWait(url, t + 2600, t + 4100);
    assert.deepEqual(readCheckHealth(url), { server: url, fails: CHECK_BREAKER_FAILS, at: t + 3100, probe: 0 });

    // and another server on the same machine is not this one
    assert.equal(checkBreaker('http://other.example:8787', 1500).skip, false);
    assert.equal(readCheckHealth('http://other.example:8787'), null);
  });
});

test('the checks stop for 15 s after the second wait, 30 s after the third, and a minute after every one from then on', () => {
  assert.equal(CHECK_BREAKER_FIRST_SKIP_MS, 15_000);
  assert.equal(CHECK_BREAKER_SKIP_MS, 60_000);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 9, 60, 1e6].map((fails) => checkBreakerSkipMs(fails)),
    [0, 0, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000, 60_000]
  );
  for (const odd of [undefined, null, NaN, 2.5, '2', -1]) assert.equal(checkBreakerSkipMs(odd), 0, String(odd));
});

test('after the second wait one hook asks again 15 s on, then 30 s, then every minute, and the hooks beside it leave the asking to that one', () => {
  const { home } = machine();
  const url = 'http://room.example:8787';
  atHome(home, () => {
    const now = Date.now();
    recordCheckWait(url, now - 3000, now - 1500);
    recordCheckWait(url, now - 1000, now);
    assert.equal(checkBreaker(url, 1500).skip, true);

    letPass(home, url, CHECK_BREAKER_FIRST_SKIP_MS - 2000);
    assert.equal(checkBreaker(url, 1500).skip, true, 'two seconds short of 15 s: still not asked');
    assert.equal(readCheckHealth(url).probe, 0, 'and nobody has set out to ask');

    letPass(home, url, 2000);
    const first = checkBreaker(url, 1500);
    assert.equal(first.skip, false, '15 s are up: this hook asks');
    assert.ok(readCheckHealth(url).probe >= now, 'and that is written down before it does');
    assert.equal(checkBreaker(url, 1500).skip, true, 'so a hook that looks while it asks does not ask too');

    // a hook that set out to ask and was never heard of again (killed by its host) holds the others up for seconds, not for good
    letPass(home, url, 10_000);
    assert.equal(checkBreaker(url, 1500).skip, false);

    // the one that asked gets no reply: one more wait, and the while starts again, twice as long
    for (const [fails, skipMs] of [[3, 30_000], [4, 60_000], [5, 60_000]]) {
      recordCheckWait(url);
      assert.equal(readCheckHealth(url).fails, fails);
      assert.equal(readCheckHealth(url).probe, 0);
      letPass(home, url, skipMs - 2000);
      assert.equal(checkBreaker(url, 1500).skip, true, `${fails} waits: not asked ${skipMs / 1000 - 2} s on`);
      letPass(home, url, 2000);
      assert.equal(checkBreaker(url, 1500).skip, false, `${fails} waits: asked ${skipMs / 1000} s on`);
      letPass(home, url, 10_000);
    }
  });
});

test('one wait on its own is forgotten after five minutes, and stopped checks are not', () => {
  const { home } = machine();
  const url = 'http://room.example:8787';
  atHome(home, () => {
    assert.equal(CHECK_WAIT_KEPT_MS, 5 * 60_000);
    const now = Date.now();
    recordCheckWait(url, now - 2000, now - 500);
    letPass(home, url, CHECK_WAIT_KEPT_MS - 1000);
    assert.equal(readCheckHealth(url).fails, 1, 'kept a little under five minutes');
    letPass(home, url, 2000);
    assert.equal(readCheckHealth(url), null, 'and not after them');
    // so the next wait is the first of a new pair, not the second of the old one
    recordCheckWait(url);
    assert.equal(readCheckHealth(url).fails, 1);
    assert.equal(checkBreaker(url, 1500).skip, false);

    // two in a row are kept however long ago: the next look is a hook asking again
    recordCheckWait(url, Date.now() + 1, Date.now() + 2);
    assert.equal(readCheckHealth(url).fails, 2);
    letPass(home, url, 24 * 3_600_000);
    assert.equal(readCheckHealth(url).fails, 2);
    assert.equal(checkBreaker(url, 1500).skip, false, 'a day on, this hook asks again');
  });
});

test('a check the hook was ended in the middle of, before half its budget, keeps nothing and clears nothing', async () => {
  const { home } = machine();
  const url = 'http://room.example:8787';
  const BUDGET = 400;
  const held1 = () => {
    atHome(home, () => clearCheckHealth(url));
    atHome(home, () => recordCheckWait(url, Date.now() - 2000, Date.now() - 1000));
    assert.equal(held(home, url).fails, 1);
  };
  // ended at once, nothing heard (the exit guard after slow git): the wait kept before stays as it was
  held1();
  let breaker = atHome(home, () => checkBreaker(url, BUDGET));
  breaker.asking();
  atHome(home, () => breaker.settle());
  assert.equal(held(home, url)?.fails, 1, 'not cleared, as a refusal or a reply would clear it');
  // ended after half its budget, nothing heard: a wait, as before
  held1();
  breaker = atHome(home, () => checkBreaker(url, BUDGET));
  breaker.asking();
  await new Promise((r) => setTimeout(r, BUDGET / 2 + 20));
  atHome(home, () => breaker.settle());
  assert.equal(held(home, url).fails, 2);
  // and a refusal heard at once still clears it
  held1();
  breaker = atHome(home, () => checkBreaker(url, BUDGET));
  breaker.asking();
  breaker.heard({ error: 'ECONNREFUSED' });
  atHome(home, () => breaker.settle());
  assert.equal(held(home, url), null);
});

test('a reply of any status clears what was kept, a refusal at once holds nothing against the server, and only a wait counts', async () => {
  const { home } = machine();
  const url = 'http://room.example:8787';
  const BUDGET = 80;
  const run = async ({ waitMs, res }) => {
    const breaker = atHome(home, () => checkBreaker(url, BUDGET));
    breaker.asking();
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
    breaker.heard(res);
    atHome(home, () => breaker.settle());
    // settling twice, as the exit listener does after the hook already has, changes nothing
    atHome(home, () => breaker.settle());
    return held(home, url);
  };

  assert.equal(await run({ waitMs: 0, res: { error: 'ECONNREFUSED' } }), null, 'refused at once: nothing kept');
  assert.equal((await run({ waitMs: BUDGET, res: { error: 'timeout' } })).fails, 1, 'no reply after the budget: a wait');
  assert.equal(await run({ waitMs: 0, res: { status: 500, json: null } }), null, 'a 500 is a reply: the server answers');
  assert.equal((await run({ waitMs: BUDGET, res: { error: 'timeout' } })).fails, 1);
  assert.equal(await run({ waitMs: 0, res: { error: 'ECONNREFUSED' } }), null, 'a refusal clears it too: down is not hung');
  // a reset that took most of the budget to come cost the edit as much as a timeout did
  assert.equal((await run({ waitMs: BUDGET * 0.75, res: { error: 'ECONNRESET' } })).fails, 1, 'what counts is the wait, not the name');
  assert.equal((await run({ waitMs: BUDGET, res: { error: 'timeout' } })).fails, 2);
  assert.equal(atHome(home, () => checkBreaker(url, BUDGET).skip), true);
  // a slow reply is a reply
  atHome(home, () => clearCheckHealth(url));
  assert.equal(await run({ waitMs: BUDGET, res: { status: 200, json: {} } }), null);
});

test('a file that is missing, empty, cut short, not what was written, about another server or from the future means a server that answers', () => {
  const { home } = machine();
  const url = 'http://room.example:8787';
  const file = healthFile(home, url);
  const now = Date.now();
  const whole = { server: url, fails: 3, at: now - 1000, probe: 0 };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const reads = (text) => {
    fs.writeFileSync(file, text);
    return atHome(home, () => ({ kept: readCheckHealth(url), skip: checkBreaker(url, 1500).skip }));
  };
  assert.deepEqual(reads(JSON.stringify(whole)), { kept: whole, skip: true }, 'the file as it is written is believed');
  for (const [what, text] of [
    ['empty', ''],
    ['cut short', JSON.stringify(whole).slice(0, 25)],
    ['not JSON', 'not json at all'],
    ['a list', '[1,2,3]'],
    ['null', 'null'],
    ['no count', JSON.stringify({ ...whole, fails: undefined })],
    ['a count that is no number', JSON.stringify({ ...whole, fails: 'many' })],
    ['a count of none', JSON.stringify({ ...whole, fails: 0 })],
    ['no time', JSON.stringify({ ...whole, at: null })],
    ['another server', JSON.stringify({ ...whole, server: 'http://elsewhere.example' })],
    ['a time ahead of the clock', JSON.stringify({ ...whole, at: now + 3_600_000 })],
  ]) {
    assert.deepEqual(reads(text), { kept: null, skip: false }, what);
  }
  fs.rmSync(file);
  assert.deepEqual(atHome(home, () => ({ kept: readCheckHealth(url), skip: checkBreaker(url, 1500).skip })), { kept: null, skip: false }, 'missing');
  // and a url that names no server keeps nothing and stops nothing
  atHome(home, () => {
    assert.equal(checkHealthPath('not a url'), null);
    recordCheckWait('not a url');
    recordCheckWait('not a url');
    assert.equal(checkBreaker('not a url', 1500).skip, false);
  });
});

test('one file a server, named by its address, with nothing in it but the address, a count and times', () => {
  const { home } = machine();
  atHome(home, () => {
    const now = Date.now();
    recordCheckWait('https://agentmash.dev', now - 1, now);
    recordCheckWait('http://127.0.0.1:8787/', now - 1, now);
    recordCheckWait('https://rooms.example/team-a?key=mash_secret#x', now - 1, now);
  });
  const dir = path.join(home, '.agentmash', 'health');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['http_127.0.0.1_8787.json', 'https_agentmash.dev.json', 'https_rooms.example_team-a.json']);
  for (const name of fs.readdirSync(dir)) {
    const kept = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    assert.deepEqual(Object.keys(kept).sort(), ['at', 'fails', 'server']);
    assert.ok(!JSON.stringify(kept).includes('mash_secret'), 'a key in a url is not kept');
  }
});

test('hooks that write and clear at once never leave a reader half a file', async () => {
  const { home } = machine();
  const url = 'http://room.example:8787';
  const file = healthFile(home, url);
  const lib = pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href;
  // four processes, each keeping 60 waits and clearing now and then, as four hooks at once would
  const writer =
    `const lib = await import(${JSON.stringify(lib)});` +
    `for (let i = 0; i < 60; i++) { lib.recordCheckWait(${JSON.stringify(url)}); if (i % 7 === 3) lib.clearCheckHealth(${JSON.stringify(url)}); }`;
  let running = 4;
  const exits = [];
  for (let i = 0; i < 4; i++) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', writer], { env: { ...baseEnv, AGENTMASH_HOME: home }, stdio: 'ignore' });
    exits.push(new Promise((resolve) => child.on('close', (code) => { running -= 1; resolve(code); })));
  }
  let whole = 0;
  let torn = 0;
  while (running > 0) {
    for (let i = 0; i < 50; i++) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue; // cleared, or not written yet: a server that answers
      }
      try {
        const kept = JSON.parse(text);
        if (kept.server === url && Number.isInteger(kept.fails) && Number.isFinite(kept.at)) whole += 1;
        else torn += 1;
      } catch {
        torn += 1;
      }
      // and the hook's own reader never throws, whatever it finds
      atHome(home, () => readCheckHealth(url));
    }
    await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual(await Promise.all(exits), [0, 0, 0, 0]);
  assert.equal(torn, 0, `${torn} reads found half a file (${whole} found a whole one)`);
  assert.ok(whole > 0, 'the reader did get to read it while it was being written');
  const left = fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(left, [], 'no half-written file is left behind');
});

// ── the hook, run as an agent runs it ───────────────────────────────────────

test('against a room that never answers, two edits wait and the ones after them ask nothing', async () => {
  const room = await startRoom('hang');
  const m = machine();
  try {
    for (let i = 1; i <= 2; i++) {
      const result = await edit(m, room.url, { budgetMs: SHORT_MS });
      silent(result, `edit ${i}`);
      assert.equal(room.checks.length, i, `edit ${i} asks the room`);
      assert.ok(result.elapsed >= SHORT_MS, `edit ${i} waited out its budget (${result.elapsed} ms)`);
    }
    assert.equal(held(m.home, room.url).fails, 2);
    for (let i = 3; i <= 6; i++) {
      const result = await edit(m, room.url, { budgetMs: SHORT_MS });
      silent(result, `edit ${i}`);
      assert.equal(room.checks.length, 2, `edit ${i} asks nothing`);
    }
    assert.equal(held(m.home, room.url).fails, 2, 'and an edit that asked nothing changes nothing');
  } finally {
    await room.close();
  }
});

test('strict mode asks before every edit, against a room that never answers too, and keeps nothing of it', async () => {
  const room = await startRoom('hang');
  const m = machine();
  const env = { AGENTMASH_STRICT: '1' };
  try {
    for (let i = 1; i <= 3; i++) {
      const result = await edit(m, room.url, { budgetMs: SHORT_MS, env });
      silent(result, `strict edit ${i}`);
      assert.equal(room.checks.length, i, `strict edit ${i} asks the room`);
    }
    assert.ok(!fs.existsSync(path.join(m.home, '.agentmash', 'health')), 'and keeps no file');

    // a file that says the room stopped answering (two waits now, as a hook
    // outside strict mode leaves it, or as anything that can write in
    // ~/.agentmash could) is no pass past strict mode
    atHome(m.home, () => {
      const now = Date.now();
      recordCheckWait(room.url, now - 3000, now - 1500);
      recordCheckWait(room.url, now - 1000, now);
    });
    silent(await edit(m, room.url, { budgetMs: SHORT_MS }), 'outside strict mode');
    assert.equal(room.checks.length, 3, 'outside strict mode the edit asks nothing');
    room.mode = 'answer';
    const strict = await edit(m, room.url, { env });
    assert.equal(strict.code, 0);
    assert.equal(room.checks.length, 4, 'strict mode asks all the same');
    assert.match(strict.stdout, /alice/, 'and is told, or stopped, by what the room says');
    assert.equal(held(m.home, room.url).fails, 2, 'and leaves what it found as it was');
  } finally {
    await room.close();
  }
});

test('a room that comes back is heard by the first edit 15 s after a short silence, and by every edit after', async () => {
  const room = await startRoom('hang');
  const m = machine();
  try {
    await edit(m, room.url, { budgetMs: SHORT_MS });
    await edit(m, room.url, { budgetMs: SHORT_MS });
    assert.equal(room.checks.length, 2);

    room.mode = 'answer';
    silent(await edit(m, room.url), 'inside the 15 s');
    assert.equal(room.checks.length, 2, 'inside the 15 s the room is not asked, back or not');

    letPass(m.home, room.url, CHECK_BREAKER_FIRST_SKIP_MS);
    const first = await edit(m, room.url);
    assert.equal(room.checks.length, 3, '15 s on: this edit asks');
    assert.match(first.stdout, /alice/, 'and is told what the room answered');
    assert.equal(held(m.home, room.url), null, 'nothing is held against a room that answered');
    assert.ok(!fs.existsSync(healthFile(m.home, room.url)), 'and its file is gone');

    const next = await edit(m, room.url);
    assert.equal(room.checks.length, 4);
    assert.match(next.stdout, /alice/);
  } finally {
    await room.close();
  }
});

test('the edit that asks again and gets no answer waits once, and the while starts over, twice as long', async () => {
  const room = await startRoom('hang');
  const m = machine();
  try {
    await edit(m, room.url, { budgetMs: SHORT_MS });
    await edit(m, room.url, { budgetMs: SHORT_MS });
    letPass(m.home, room.url, CHECK_BREAKER_FIRST_SKIP_MS);

    const asked = await edit(m, room.url, { budgetMs: SHORT_MS });
    silent(asked, 'the edit that asks again');
    assert.equal(room.checks.length, 3);
    const kept = held(m.home, room.url);
    assert.equal(kept.fails, 3);
    assert.ok(Date.now() - kept.at < CHECK_BREAKER_FIRST_SKIP_MS, 'the while counts from this silence');

    silent(await edit(m, room.url, { budgetMs: SHORT_MS }), 'the edit after');
    assert.equal(room.checks.length, 3, 'and the edits after it ask nothing again');
    letPass(m.home, room.url, CHECK_BREAKER_FIRST_SKIP_MS);
    silent(await edit(m, room.url, { budgetMs: SHORT_MS }), '15 s on');
    assert.equal(room.checks.length, 3, '15 s on, not yet: 30 s this time');
    letPass(m.home, room.url, CHECK_BREAKER_FIRST_SKIP_MS);
    silent(await edit(m, room.url, { budgetMs: SHORT_MS }), '30 s on');
    assert.equal(room.checks.length, 4, '30 s on: asked again');
    assert.equal(held(m.home, room.url).fails, 4, 'and no answer again: a minute, from now on');
  } finally {
    await room.close();
  }
});

test('while one hook asks again, a hook started beside it asks nothing', async () => {
  const room = await startRoom('hang');
  const m = machine();
  try {
    await edit(m, room.url, { budgetMs: SHORT_MS });
    await edit(m, room.url, { budgetMs: SHORT_MS });
    letPass(m.home, room.url, CHECK_BREAKER_SKIP_MS);

    // long enough that the first is still waiting when the second has come and gone
    const asking = edit(m, room.url, { budgetMs: within(2000) });
    const deadline = Date.now() + within(2000);
    while (room.checks.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.equal(room.checks.length, 3, 'the first hook is asking');

    const beside = await edit(m, room.url, { budgetMs: within(2000) });
    silent(beside, 'the hook beside it');
    assert.equal(room.checks.length, 3, 'one hook asks for all of them');
    silent(await asking, 'the hook that asked');
  } finally {
    await room.close();
  }
});

test('two hooks that time out side by side are one silence, and the edit after them is the second', async () => {
  const room = await startRoom('hang');
  const m = machine();
  try {
    // a budget long enough that both are waiting at once, however the machine staggers their start
    const budgetMs = within(1200);
    const [a, b] = await Promise.all([edit(m, room.url, { budgetMs }), edit(m, room.url, { budgetMs })]);
    silent(a, 'one');
    silent(b, 'the other');
    assert.equal(room.checks.length, 2, 'both asked');
    assert.equal(held(m.home, room.url).fails, 1, 'and ran out together: one silence');

    await edit(m, room.url, { budgetMs: SHORT_MS });
    assert.equal(held(m.home, room.url).fails, 2);
    await edit(m, room.url, { budgetMs: SHORT_MS });
    assert.equal(room.checks.length, 3, 'so the edit after that asks nothing');
  } finally {
    await room.close();
  }
});

test('a room that is down, or answers with an error, has nothing held against it and is asked every time', async () => {
  const m = machine();
  // a port nothing listens on: refused in milliseconds
  const closed = await startRoom();
  const downUrl = closed.url;
  await closed.close();
  for (let i = 1; i <= 3; i++) silent(await edit(m, downUrl), `down, edit ${i}`);
  assert.ok(!fs.existsSync(path.join(m.home, '.agentmash', 'health')), 'a refusal keeps no file');

  const room = await startRoom('error');
  try {
    for (let i = 1; i <= 3; i++) {
      silent(await edit(m, room.url), `a 500, edit ${i}`);
      assert.equal(room.checks.length, i, 'a room that answers, even badly, is asked');
    }
    assert.equal(held(m.home, room.url), null);

    // and one wait is forgotten at the room's next reply, whatever it says
    room.mode = 'hang';
    await edit(m, room.url, { budgetMs: SHORT_MS });
    assert.equal(held(m.home, room.url).fails, 1);
    room.mode = 'error';
    await edit(m, room.url);
    assert.equal(held(m.home, room.url), null, 'a wait and then a reply are not two waits in a row');
    room.mode = 'hang';
    await edit(m, room.url, { budgetMs: SHORT_MS });
    assert.equal(held(m.home, room.url).fails, 1);
  } finally {
    await room.close();
  }
});

test('what a strict-mode block kept back for the session is still said while the room is not asked', async () => {
  const room = await startRoom('hang');
  const m = machine();
  const sessionId = session();
  try {
    atHome(m.home, () => {
      const now = Date.now();
      recordCheckWait(room.url, now - 3000, now - 1500);
      recordCheckWait(room.url, now - 1000, now);
    });
    writeSessionCache(sessionId, {
      findings_kept: [
        {
          finding: {
            id: 'o_breaker000001',
            type: 'dead_end',
            title: 'Rounding in charge() with Math.round breaks refunds of odd cents',
            facts: ['Refund of 101 cents split in two gave 51 + 51.'],
            files: ['src/models/user.ts'],
            symbols: ['charge'],
            branch: 'main',
            head: null,
            developer: 'alim',
            agent: 'claude-code',
            first_ts: Date.now() - 240_000,
            last_ts: Date.now() - 240_000,
            people: 1,
            commit: null,
            about: 'src/models/user.ts',
            blob: null,
          },
          top: m.project,
          at: Date.now(),
        },
      ],
    });
    const result = await edit(m, room.url, { sessionId });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(room.checks.length, 0, 'the room is not asked');
    assert.match(result.stdout, /Rounding in charge\(\) with Math\.round breaks refunds of odd cents/, 'and the kept finding is said');
  } finally {
    await room.close();
  }
});

test("today's hook beside a lib.mjs from before the breaker asks every time, as it always did", async () => {
  const room = await startRoom('hang');
  const m = machine();
  const vendored = tempDir('agentmash-breaker-oldlib-');
  const today = fs.readFileSync(path.join(HOOKS_DIR, 'lib.mjs'), 'utf8');
  const start = today.indexOf('// ── a server that stopped answering');
  const end = today.indexOf('// ── edits the edit tools never see');
  assert.ok(start > 0 && end > start, 'the section is where this test cuts it out');
  const before = today.slice(0, start) + today.slice(end);
  assert.ok(!before.includes('checkBreaker'), 'the stand-in lib really lacks the breaker');
  fs.writeFileSync(path.join(vendored, 'lib.mjs'), before);
  fs.copyFileSync(path.join(HOOKS_DIR, 'pre_tool_use.mjs'), path.join(vendored, 'pre_tool_use.mjs'));
  try {
    for (let i = 1; i <= 3; i++) {
      const result = await runHook(
        'pre_tool_use.mjs',
        {
          session_id: session(),
          cwd: m.project,
          hook_event_name: 'PreToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: path.join(m.project, 'src', 'models', 'user.ts'), old_string: 'a', new_string: 'b' },
        },
        { CLAUDE_PROJECT_DIR: m.project, AGENTMASH_HOME: m.home, AGENTMASH_URL: room.url, AGENTMASH_ROOM: KEY, AGENTMASH_DEV: 'bob', AGENTMASH_TIMEOUT_MS: String(SHORT_MS) },
        [],
        { dir: vendored }
      );
      silent(result, `edit ${i}`);
      assert.equal(room.checks.length, i, `edit ${i} asks the room`);
    }
    assert.ok(!fs.existsSync(path.join(m.home, '.agentmash', 'health')), 'and keeps nothing about it');
  } finally {
    await room.close();
  }
});
