// Talking to the AgentMash coordination server from the MCP process.
//
// This deliberately reuses the hooks' config resolution (lib.mjs, beside this
// file wherever it is installed), so an agent's MCP tools and its hooks always
// read the same room out of the same place. There is no second credential and
// no second config file.
//
// Unlike the hooks, nothing here fails silently: an MCP tool that returns
// nothing reads to the agent as "nobody is working on anything", which is a
// confident lie when the server is merely down. Every failure is therefore
// carried back to the caller as a named reason, so the tool can say what it
// actually knows.

import path from 'node:path';
import { getDeveloper, loadConfig, widenConnectAttempts } from './lib.mjs';
// Namespace import for anything added to lib.mjs after these three: a partial
// merge can leave this file beside an older lib.mjs, and a missing *named*
// import is a module-link error that keeps the whole server from starting.
import * as lib from './lib.mjs';

/**
 * The hooks run inside an edit and cap at 1.5 s. An MCP tool is called while
 * the agent is planning and is waiting on the answer, so it can afford to be
 * more patient — but not so patient that a hung server stalls the turn.
 */
export const DEFAULT_TIMEOUT_MS = 4000;

/**
 * @typedef {object} Coordination
 * @property {string} url        Coordination server origin, no trailing slash.
 * @property {string} room       Room id, or a room's ref on a signed-in machine — empty when this repo isn't connected.
 * @property {string} roomRef    The room's ref (rm_…) where the config says it, or the room itself when that is a ref; else ''.
 * @property {string} token      Developer token for this room from this machine (`npx agentmash login --room`), or ''.
 * @property {string} user       This machine's own token when it is signed in (`npx agentmash login`) and the room was
 *                               found by the repository, or ''.
 * @property {string} paused    'reauth' when this machine's sign-in found no room because the server wants GitHub to
 *                               say again what it can push to, or ''.
 * @property {boolean} disabled  AGENTMASH_DISABLE=1, the team's kill switch.
 * @property {string} developer  Who this agent's own edits are attributed to.
 * @property {string} dev        AGENTMASH_DEV when it is set (the developer above, set on purpose), or ''.
 * @property {string} projectDir Repo root the config was resolved from.
 * @property {number} timeoutMs  Per-request budget.
 */

/**
 * The room and credentials the hooks would use here, the same way: the
 * repository's committed config, with the developer token this machine holds
 * for its room; or, in a checkout with no room of its own on a machine signed
 * in with `npx agentmash login`, the room its repository is connected to,
 * named by its ref and signed with the machine's token, as the hooks that
 * sign-in installed find it (lib.resolveConfig). A room in a repository that
 * has one is never swapped for that: there the sign-in's hooks step aside too.
 *
 * @returns {Promise<Coordination>}
 */
export async function resolveCoordination(projectDir) {
  const dir = path.resolve(projectDir);
  // the repository's room signed beside its key, as the hooks sign it (lib.withSignIn)
  let config = lib.withSignIn?.(loadConfig(dir)) ?? loadConfig(dir);
  let paused = '';
  if (!config.room && !config.disabled && lib.resolveConfig && !lib.hasRepoInstall?.(dir)) {
    // An agent asks the MCP now and then, not at every edit, and one with no
    // hooks (Zed) has nothing else that asks again: so a repository nobody
    // connected is looked up again as the hooks' background reports do, and
    // one connected on the website since is found within a minute.
    const signedIn = await lib.resolveConfig(dir, { global: true, background: true });
    // anything short of a room found leaves this repo not connected, which is
    // what it is: the sign-in's own "disabled" is not the team's kill switch.
    // Short of one because the machine's push access went stale, it is paused,
    // on the server the sign-in is with.
    if (signedIn.global && signedIn.room) config = signedIn;
    else if (signedIn.paused) {
      paused = signedIn.paused;
      config = { ...config, url: signedIn.url };
    }
  }
  const override = Number(process.env.AGENTMASH_MCP_TIMEOUT_MS);
  return {
    url: config.url,
    room: config.room,
    // the teammate inbox names its room by ref, beside the machine's sign-in (mcp_server.mjs, inboxAccess)
    roomRef: config.roomRef || (String(config.room || '').startsWith('rm_') ? config.room : ''),
    token: config.token || '',
    user: config.user || '',
    paused,
    // AGENTMASH_DISABLE is the team's kill switch for the hooks; it turns the
    // query tools off too, so switching AgentMash off switches all of it off.
    disabled: config.disabled,
    developer: getDeveloper(config, dir),
    // AGENTMASH_DEV, which the developer above is when it is set: said on every request, as the hooks say it
    dev: config.dev || '',
    projectDir: dir,
    // AGENTMASH_WARN_SELF, which says whether a claim goes by the desktop app's session (sessionId in mcp_server.mjs)
    warnSelf: config.warnSelf === true,
    timeoutMs: Number.isFinite(override) && override > 0 ? override : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Why an answer is missing. Each reason produces different wording for the
 * agent, because "the server is down" and "the room is quiet" are opposite
 * facts that a raw empty result would render identically.
 *
 * @typedef {'disabled'|'not_configured'|'unreachable'|'timeout'|'unauthorized'|'plan'|'http_error'|'bad_response'} FailureReason
 */

/**
 * @typedef {{ok: true, data: any, ms: number}
 *         | {ok: false, reason: FailureReason, detail: string, status?: number, code?: string, said?: string, ms: number}} Answer
 *
 * `said` is the server's own sentence for a refusal, where it gave one, printable and short.
 */

/** GET a JSON endpoint on the coordination server. Never throws. @returns {Promise<Answer>} */
export function fetchJson(coordination, pathAndQuery) {
  return requestJson(coordination, pathAndQuery);
}

/** POST a JSON body. Same failure vocabulary as fetchJson. @returns {Promise<Answer>} */
export function postJson(coordination, pathAndQuery, body) {
  return requestJson(coordination, pathAndQuery, { method: 'POST', body });
}

/** @returns {Promise<Answer>} */
export async function requestJson(coordination, pathAndQuery, { method = 'GET', body } = {}) {
  if (coordination.disabled) {
    return { ok: false, reason: 'disabled', detail: 'AGENTMASH_DISABLE=1', ms: 0 };
  }
  // the lookup was turned away, as every room request would be (see resolveCoordination)
  if (coordination.paused) {
    const code = coordination.paused;
    return { ok: false, reason: 'unauthorized', status: 401, code, detail: `the room lookup answered HTTP 401 ${code}`, ms: 0 };
  }
  if (!coordination.room) {
    return { ok: false, reason: 'not_configured', detail: 'no room id resolved', ms: 0 };
  }
  const started = Date.now();
  let res;
  try {
    widenConnectAttempts(coordination.timeoutMs);
    res = await fetch(`${coordination.url}${pathAndQuery}`, {
      method,
      // The credentials exactly as the hooks send them (request in lib.mjs):
      // a room that requires developer tokens refuses a write without one,
      // and a signed-in machine names its room by ref and signs as itself.
      headers: {
        'content-type': 'application/json',
        'x-agentmash-room': coordination.room,
        ...(coordination.token ? { 'x-agentmash-token': coordination.token } : {}),
        ...(coordination.user ? { 'x-agentmash-user': coordination.user } : {}),
        ...(coordination.dev ? { 'x-agentmash-developer-source': 'env' } : {}),
        // which version of the hooks asks, as lib.mjs's own requests say (HOOKS_VERSION)
        ...(lib.HOOKS_VERSION ? { 'x-agentmash-hooks': lib.HOOKS_VERSION } : {}),
        connection: 'close',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(coordination.timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      ok: false,
      reason: timedOut ? 'timeout' : 'unreachable',
      detail: timedOut ? `no response within ${coordination.timeoutMs}ms` : String(err?.message || err),
      ms: Date.now() - started,
    };
  }

  const ms = Date.now() - started;
  if (res.status === 401 || res.status === 403) {
    // The server's code says which credential it turned away (a room key, a
    // developer token, a sign-in), and so which command fixes it: the agent
    // is told that, not that the room may be gone.
    let code = '';
    try {
      const json = await res.json();
      if (typeof json?.code === 'string') code = json.code.slice(0, 60);
    } catch {
      // no body to read: the status alone says it was turned away
    }
    return { ok: false, reason: 'unauthorized', status: res.status, code, detail: `HTTP ${res.status}${code ? ` ${code}` : ''}`, ms };
  }
  if (res.status === 402) {
    // The team's plan has no seat for this developer (a server that enforces
    // plans): the server's own words say so and where to upgrade, and they
    // are what the agent is told, never that the server is unreachable.
    let json = null;
    try {
      json = await res.json();
    } catch {
      // the status alone says it
    }
    const code = typeof json?.code === 'string' ? json.code.slice(0, 60) : '';
    const said = typeof json?.message === 'string' && json.message.trim() ? json.message.trim().slice(0, 400) : `HTTP 402${code ? ` ${code}` : ''}`;
    return { ok: false, reason: 'plan', status: 402, code, detail: said, ms };
  }
  if (!res.ok) {
    // the server's code and sentence, where it gave them: the inbox's refusals (a hop limit, a full inbox) say what to do
    let json = null;
    try {
      json = await res.json();
    } catch {
      // no body to read: the status alone says it
    }
    const code = typeof json?.code === 'string' ? json.code.slice(0, 60) : '';
    const said = typeof json?.error === 'string' ? json.error.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 300) : '';
    return { ok: false, reason: 'http_error', status: res.status, code, said, detail: `HTTP ${res.status}${code ? ` ${code}` : ''}`, ms };
  }
  try {
    return { ok: true, data: await res.json(), ms };
  } catch {
    return { ok: false, reason: 'bad_response', detail: 'the response body was not JSON', ms };
  }
}

/** Repo-relative, forward slashes, no leading "./" or trailing "/" — as the hooks report paths. */
export function normalizePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}
