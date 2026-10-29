#!/usr/bin/env node
// The MCP server as a teammate receives it.
//
// It lives beside the hooks because it travels the same way they do: both
// installers copy it into .claude/agentmash/, the team commits it, and a
// teammate gets it by `git pull`. So does the server it starts,
// mcp_server.mjs, with its two helpers and the lib.mjs they share with the
// hooks: plain Node, nothing to install. (It used to need
// @modelcontextprotocol/sdk, which a teammate's checkout has no reason to
// contain, so outside an AgentMash checkout this file only ever reached layer
// 3.) This file finds a server and hands stdio to it, in three layers, tried
// in order:
//
//   1. a server, imported in-process: AGENTMASH_MCP_ENTRY when it is set;
//      then the one committed beside this file, unless this machine's
//      `npx agentmash login` keeps a newer copy in ~/.agentmash/hooks, which a
//      repo that ran init months ago should not hold back; then the source in
//      a checkout of AgentMash itself, which commits this file and no server
//      beside it, or the package's in the node_modules of a repo that
//      installed `agentmash`, never one above the repo; and last the login's
//      copy whatever its version, which beats no server at all;
//   2. the published package by way of `npx`, off unless this machine sets
//      AGENTMASH_MCP_NPX=1, because it downloads and executes code from the
//      registry and that is not a decision the repo gets to make for you;
//   3. a degraded server, implemented below in plain JSON-RPC, that starts,
//      answers tools/list, and makes every call say that AgentMash could not
//      start and the answer is UNKNOWN. Only a server file that is missing or
//      broken comes to this.
//
// Layer 3 is why this file is more than an import. An MCP server that fails to
// start is invisible to the agent: the tools are simply absent, so it stops
// asking and carries on as though nobody else were working in the repo — the
// one wrong answer this project exists to prevent. Registering a server that
// says "I do not know" is worse than one that works and far better than one
// that is missing, because only the agent can act on the difference.
//
// The repository is the one this file is installed in, not the folder Claude
// Code started the session in (see repoDir), and .mcp.json finds this file
// from whichever folder that was, by walking up, no higher than the folder
// that registered it or the repository's root (see MCP_SERVER_ENTRY in
// cli/agentmash.mjs).
//
// Nothing but JSON-RPC is ever written to stdout: that channel is the
// protocol. Diagnostics go to stderr, where Claude Code logs them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The version is stamped in by cli/sync-hooks.mjs at pack time, so the copy of
// this file that ships inside a package always names the version it shipped
// with. Change the marker comment and the stamp stops happening silently — the
// packer throws instead. A hand-edited constant is how this file came to pin a
// version that was never published. The checked-in value is the one the web
// installer commits — it has no packer to stamp it — so it has to be moved with
// the version bump; cli/test/package.test.mjs diffs the two installers and fails
// if it drifts.
const PINNED_VERSION = '0.13.5'; // agentmash:pin
const PACKAGE_SPEC = process.env.AGENTMASH_MCP_PACKAGE || `agentmash@${PINNED_VERSION}`;

/**
 * Layer 2 is opt-in. It fetches a package from the network and runs it at
 * session start, which is a decision for the person whose machine it is, not
 * for whoever ran `agentmash init` and committed the result. Off, the worst
 * case is layer 3: tools that are present and say they cannot answer.
 */
const NPX_ENABLED = process.env.AGENTMASH_MCP_NPX === '1';

/** Long enough for a cold `npx` download, short enough to still answer a client. */
const NPX_BUDGET_MS = Number(process.env.AGENTMASH_MCP_NPX_TIMEOUT_MS) || 25_000;

/**
 * The versions of MCP this shim implements, newest first, as mcp_server.mjs
 * has them (it cannot import them: that file may be the thing that is
 * missing). A client asking for one of them gets it; one asking for anything
 * else gets the newest, not its own back, which would claim support for
 * whatever it happened to send.
 */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
/** The `-unavailable` suffix is how `agentmash doctor` recognises layer 3. */
const DEGRADED_VERSION = '0.1.0-unavailable';

/** The server, as both installers commit it beside this file and as a login keeps a copy of it. */
const SERVER_FILE = 'mcp_server.mjs';

const log = (message) => process.stderr.write(`[agentmash-mcp] ${message}\n`);

/**
 * The repository this was installed into: .claude/agentmash/<this file> is
 * two levels down. Not CLAUDE_PROJECT_DIR: Claude Code sets that to the folder
 * the session started in, which is a subfolder as often as the root, and the
 * room's config is at the root.
 */
function repoDir() {
  return path.resolve(HERE, '..', '..');
}

/** Where `npx agentmash login` keeps this machine's hooks, and a copy of the server with them. */
function machineHookDir() {
  return path.join(process.env.AGENTMASH_HOME || os.homedir(), '.agentmash', 'hooks');
}

/** `export const VERSION = '0.5.0'; // agentmash:version`, as cli/sync-hooks.mjs stamps it. */
const VERSION_STAMP = /^export const VERSION = '(\d+)\.(\d+)\.(\d+)[^']*'; \/\/ agentmash:version/m;

/** The version stamped into a copy of the server, as [major, minor, patch]; null when there is none to read. */
function stampedVersion(file) {
  try {
    const m = fs.readFileSync(file, 'utf8').match(VERSION_STAMP);
    return m ? m.slice(1, 4).map(Number) : null;
  } catch {
    return null;
  }
}

/**
 * Whether version `a` comes after version `b`, by major, minor and patch.
 * VERSION_STAMP reads no further, so a prerelease tag counts for nothing: a
 * login's 0.6.0-beta beats a committed 0.5.0, as it should, but a login's 0.6.0
 * does not beat a committed 0.6.0-beta, which semver puts before it. Fine while
 * nothing is published with a tag; a release that is should compare it too.
 */
function isNewer(a, b) {
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** Candidate copies of the server, in the order layer 1 tries them. */
function entryCandidates(repo) {
  const candidates = [];
  if (process.env.AGENTMASH_MCP_ENTRY) candidates.push(process.env.AGENTMASH_MCP_ENTRY);
  const beside = path.join(HERE, SERVER_FILE);
  const machine = path.join(machineHookDir(), SERVER_FILE);
  // The copy the repo committed is the one the whole team runs. A newer login
  // on this machine means a newer server than the repo has caught up with;
  // an older one does not get to take the repo's back.
  if (isNewer(stampedVersion(machine), stampedVersion(beside))) candidates.push(machine);
  candidates.push(beside);
  // A checkout of AgentMash itself, which commits this file and no server
  // beside it: its source, known by the launcher's source beside it, since an
  // mcp/server.mjs alone could be any repo's own server.
  if (fs.existsSync(path.join(repo, 'hooks', 'mcp_launcher.mjs'))) candidates.push(path.join(repo, 'hooks', SERVER_FILE));
  // A repo that installed the package, at its root, where a monorepo's
  // node_modules is too. Never a folder above the repo: what is installed
  // there is not the repo's to vouch for, and on Windows any local user can
  // make a C:\node_modules.
  candidates.push(path.join(repo, 'node_modules', 'agentmash', 'mcp', 'server.mjs'));
  // Nothing committed beside this file: this machine's copy, whatever its
  // version, is better than tools that can only say they cannot answer.
  candidates.push(machine);
  return [...new Set(candidates)].filter((file) => fs.existsSync(file));
}

/** A path as a teammate would know it: inside the repo, from its root. */
function shownPath(file, repo) {
  const rel = path.relative(repo, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : file;
}

/**
 * Layer 1. Returns `{ served: true }`, or why none of the copies could run: a
 * file that is not there, or one that is but throws as it loads (a lib.mjs
 * beside it from another version, an older copy whose dependencies are not
 * installed here).
 */
async function serveInProcess(repo) {
  // An older copy of the server, from a package installed in node_modules,
  // reads the repository from CLAUDE_PROJECT_DIR; a copy from now is told it.
  process.env.CLAUDE_PROJECT_DIR = repo;
  // the first copy that failed is the one this repo meant to run
  let detail = null;
  for (const entry of entryCandidates(repo)) {
    try {
      const module = await import(pathToFileURL(entry).href);
      await module.start({ repo });
      return { served: true };
    } catch (err) {
      detail ??= `${shownPath(entry, repo)} could not start: ${err?.message || err}`;
      log(`cannot run ${entry}: ${err?.message || err}`);
    }
  }
  return {
    served: false,
    detail: detail ?? `the MCP server is missing: there is no ${SERVER_FILE} beside this launcher in .claude/agentmash/`,
  };
}

/** Quote one argument for a Windows shell, which is what `.cmd` needs to run. */
const quoteForShell = (arg) => (/^[\w@.:=/\\-]+$/.test(arg) ? arg : `"${String(arg).replace(/"/g, '""')}"`);

/**
 * How layer 2 is spawned, per platform. Exported so a test can check the
 * Windows form on a machine that is not Windows: since the BatBadBut fix
 * (Node 18.20.2 / 20.12.2 / 21.7.3) `spawn` refuses a `.cmd` without
 * `shell: true` and throws EINVAL, which silently cost Windows layer 2
 * altogether — and a shell in turn means the arguments have to be quoted,
 * into the one command line the shell is given: a list beside `shell: true`
 * is joined with spaces as it is, and Node 24 warns about it (DEP0190).
 */
export function npxInvocation(platform, spec) {
  // `--package <spec> -- agentmash mcp` rather than `npx <spec> mcp`: it names
  // the binary explicitly, so a spec that is a path or a tarball is still
  // installed rather than executed.
  const args = ['--yes', '--package', spec, '--', 'agentmash', 'mcp'];
  if (platform !== 'win32') return { command: 'npx', args, shell: false };
  return { command: ['npx.cmd', ...args.map(quoteForShell)].join(' '), args: [], shell: true };
}

/**
 * True for a line that is a JSON-RPC message and not, say, an npm update
 * notice. Forwarding anything else would corrupt the protocol stream, and
 * treating it as proof the child is alive would strand the client on a server
 * that never answers.
 */
export function isJsonRpcLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.jsonrpc === '2.0';
}

/**
 * Layer 2. Hand stdio to `npx agentmash mcp` and get out of the way.
 *
 * The handover is reversible on purpose: everything the client sends is kept
 * until the child has answered something, so if `npx` cannot reach the
 * registry — no network, package not published yet — we can still fall through
 * to layer 3 and replay the requests to it, instead of leaving the client
 * talking to a corpse.
 *
 * @returns {Promise<{served: boolean, detail?: string, replay?: Buffer[]}>}
 */
function serveViaNpx(onStdin) {
  return new Promise((resolve) => {
    const { command, args, shell } = npxInvocation(process.platform, PACKAGE_SPEC);
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'inherit'],
        shell,
        env: { ...process.env, CLAUDE_PROJECT_DIR: repoDir() },
      });
    } catch (err) {
      return resolve({ served: false, detail: `could not run npx: ${err?.message || err}` });
    }

    const buffered = [];
    let answered = false;
    let settled = false;
    let out = '';

    const timer = setTimeout(() => {
      if (answered || settled) return;
      child.kill();
      give(`npx ${PACKAGE_SPEC} did not answer within ${NPX_BUDGET_MS}ms`);
    }, NPX_BUDGET_MS);
    timer.unref?.();

    function give(detail) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onStdin(null);
      resolve({ served: false, detail, replay: buffered });
    }

    /** Forward whole lines, and only the ones that are protocol. */
    function drain(final) {
      let index;
      while ((index = out.indexOf('\n')) !== -1) {
        const line = out.slice(0, index);
        out = out.slice(index + 1);
        take(line);
      }
      if (final && out.trim()) {
        take(out);
        out = '';
      }
    }

    function take(line) {
      if (!line.trim()) return;
      if (!isJsonRpcLine(line)) {
        log(`ignored non-protocol output from npx: ${line.trim().slice(0, 200)}`);
        return;
      }
      answered = true;
      clearTimeout(timer);
      process.stdout.write(line + '\n');
    }

    onStdin((chunk) => {
      if (settled) return;
      buffered.push(chunk);
      try {
        child.stdin.write(chunk);
      } catch {
        /* the child is gone; the exit handler decides what happens next */
      }
    });

    child.stdin.on('error', () => {
      /* EPIPE when npx fails before reading — handled on exit */
    });
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
      drain(false);
    });
    child.on('error', (err) => give(`could not run npx: ${err?.message || err}`));
    child.on('exit', (code, signal) => {
      drain(true);
      if (answered) {
        // It spoke, so the session had a working server; its death is the
        // client's problem to report, not something to paper over here.
        settled = true;
        clearTimeout(timer);
        resolve({ served: true });
        process.exit(code ?? 0);
      }
      give(`npx ${PACKAGE_SPEC} exited ${signal || code} before answering`);
    });
  });
}

// ── layer 3: the degraded server ───────────────────────────────────────────

const TOOLS = [
  {
    name: 'who_is_working_on_what',
    title: 'Who is working on what',
    description:
      'Reports who else is working in this repository. UNAVAILABLE on this machine: AgentMash could not start its MCP server, so this cannot answer and must not be read as "nobody is working on anything".',
  },
  {
    name: 'has_anyone_touched',
    title: 'Has anyone touched this path',
    description:
      'Reports whether a teammate recently edited a path. UNAVAILABLE on this machine: AgentMash could not start its MCP server, so a quiet answer here would be a guess, not a fact.',
  },
  {
    name: 'list_contested_files',
    title: 'List contested files',
    description:
      'Lists files more than one person has edited recently. UNAVAILABLE on this machine: AgentMash could not start its MCP server.',
  },
];

function unavailableText(detail) {
  return `AgentMash could not start its MCP server on this machine, so it cannot say who is working in this repository.

Treat the answer as UNKNOWN. This is not the same as "nobody is working on anything" — AgentMash never got to ask.

Reason: ${detail}

The hooks are unaffected: if this repo is connected, teammates' edits are still reported and you will still be warned before you edit a file someone just changed. Only these query tools are missing.

The server is plain Node and needs nothing installed: it is committed beside the hooks, in .claude/agentmash/. To fix it:
  npx agentmash doctor          says exactly what is missing
  npx agentmash init            run again in this repository, puts the server back beside the
                                hooks; commit .claude and every teammate has it on their next pull
  npx agentmash login           keeps a copy of the server on this machine, for every repository
  AGENTMASH_MCP_ENTRY=<path>    run a copy from somewhere else, such as an AgentMash checkout

Each npx command needs network access to npm once; without it these tools stay unavailable.`;
}

/**
 * MCP over stdio is newline-delimited JSON-RPC, which is little enough
 * protocol to implement here — and implementing it here is the point: the
 * degraded server has to run on a machine that has no dependencies at all.
 */
function createDegradedServer(detail) {
  const message = unavailableText(detail);
  let buffer = '';

  const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, msg) => send({ jsonrpc: '2.0', id, error: { code, message: msg } });

  function handle(request) {
    const { id, method, params } = request ?? {};
    if (id === undefined || id === null) return; // a notification: nothing to answer
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion)
            ? params.protocolVersion
            : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'agentmash', version: DEGRADED_VERSION },
          instructions:
            'AgentMash is registered here but could not start. Its tools report themselves unavailable; never read that as "nobody is working on anything".',
        });
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, {
          tools: TOOLS.map((tool) => ({
            ...tool,
            inputSchema: { type: 'object', properties: {}, additionalProperties: true },
            annotations: { readOnlyHint: true, openWorldHint: true },
          })),
        });
      case 'tools/call':
        return reply(id, { content: [{ type: 'text', text: message }], isError: true });
      default:
        return fail(id, -32601, `method not found: ${method}`);
    }
  }

  return {
    feed(chunk) {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
          continue;
        }
        handle(request);
      }
    },
  };
}

// ── wiring ─────────────────────────────────────────────────────────────────

async function main() {
  const repo = repoDir();
  const local = await serveInProcess(repo);
  if (local.served) return;

  // One stdin reader for the whole process: layer 2 borrows it and hands it
  // back, so no request is lost when the handover fails.
  let sink = null;
  const pending = [];
  process.stdin.on('data', (chunk) => (sink ? sink(chunk) : pending.push(chunk)));
  const setSink = (next) => {
    sink = next;
    if (!next) return;
    while (pending.length) next(pending.shift());
  };

  let detail = local.detail;
  if (NPX_ENABLED) {
    const attempt = await serveViaNpx(setSink);
    if (attempt.served) return;
    if (attempt.detail) detail = `${detail}; and ${attempt.detail}`;
    pending.unshift(...(attempt.replay || []));
  }

  log(`degraded: ${detail}`);
  const degraded = createDegradedServer(detail);
  setSink((chunk) => degraded.feed(chunk));
}

// Set only by the tests, which import this file to check the pieces that cannot
// be run on the platform the tests run on. Unset — which is everywhere else —
// this file always starts a server, because a launcher that quietly declines to
// start is the failure it exists to prevent.
if (process.env.AGENTMASH_MCP_IMPORT_ONLY !== '1') {
  main().catch((err) => {
    log(`fatal: ${err?.stack || err}`);
    process.exit(1);
  });
}
