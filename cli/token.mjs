// `npx agentmash token`: personal API tokens, for a person's own scripts and
// tools to call /api/v1 as them.
//
//   npx agentmash token create [--name <name>] [--read-only] [--repo owner/name]
//                              [--expires 90d|never] [--json]
//   npx agentmash token list [--json]
//   npx agentmash token revoke <tok_…|name> [--json]
//
// They are made, listed and revoked with this machine's sign-in (`npx
// agentmash login`, kept in ~/.agentmash/user.json), the one credential the
// server lets mint a token: a token cannot make another, and a room key
// cannot either. The sign-in goes only to the server that issued it, never to
// another named with --server, and never on through a redirect.
//
// A token is in the server's answer to `create` and nowhere else, ever. It is
// printed alone on stdout, so `TOKEN=$(npx agentmash token create --name ci)`
// captures it and nothing more; everything said around it goes to stderr.
//
// The CLI's shared argument parser reads a flag it does not know as taking
// the next word, and refuses one given twice, so this file reads its own
// arguments, raw: --read-only takes no value, and --repo may come again.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const REQUEST_TIMEOUT_MS = 10_000;
/** The longest a token can be asked to last; the server's own default is 90 days. */
const MAX_DAYS = 365;
const NAME_MAX = 60;
/** owner/name, as the server reads one (db.ts, normalizeRepo): GitHub's names are the same in any case. */
const REPO = /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/;
/** Repositories one token may be limited to (api-tokens.ts, REPOS_MAX). */
const REPOS_MAX = 50;
const TOKEN_ID = /^tok_[A-Za-z0-9_-]{1,64}$/;
/** What to do when the GitHub sign-in the server goes by is too old (config.ts, PUSH_ACCESS_DAYS): 401 reauth. */
const REAUTH =
  'GitHub has to say again what you can push to before this machine can manage tokens: run npx agentmash login, then try again';

const USAGE = `
  npx agentmash token create [--name <name>] [--read-only] [--repo owner/name]
                             [--expires 90d|never] [--json]
      make a personal API token for /api/v1, shown once
        --name        what it is for, up to 60 characters (default: "cli" and today's date)
        --read-only   reads only: anything it sends but a GET is refused
        --repo        only this repository; again, or comma-separated, for more, up to 50
                      (default: every repository you can push to)
        --expires     days it lasts, 1 to 365 (default 90d), or never
  npx agentmash token list [--json]
      your tokens, never their secrets
  npx agentmash token revoke <tok_…|name> [--json]
      stop one working, now
`;

// Colour for a person at a terminal, and only then (as agentmash.mjs).
const colour = (stream) => Boolean(stream.isTTY) && !process.env.NO_COLOR;
const paint = (on, code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const outColour = colour(process.stdout);
const errColour = colour(process.stderr);
const c = {
  bold: paint(outColour, 1),
  dim: paint(outColour, 2),
  green: paint(outColour, 32),
  cyan: paint(outColour, 36),
};
const e = {
  bold: paint(errColour, 1),
  dim: paint(errColour, 2),
  green: paint(errColour, 32),
  yellow: paint(errColour, 33),
  red: paint(errColour, 31),
};

class UsageError extends Error {}
/** What fail() throws, for cmdToken to say. */
class Failure extends Error {}

/**
 * End the command with `message`: cmdToken prints it and sets exit code 1.
 * Thrown, never process.exit(), which right after a request crashes Node on
 * Windows while its socket is still closing (see die in agentmash.mjs).
 */
function fail(message) {
  throw new Failure(message);
}

/** Text a server sent, safe to print: no escape sequence or line break of its own. */
const clean = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

// ── arguments ───────────────────────────────────────────────────────────────

const VALUES = { '--name': 'name', '--repo': 'repo', '--expires': 'expires', '--server': 'server' };
const SWITCHES = { '--read-only': 'readOnly', '--json': 'json', '--help': 'help', '-h': 'help' };

/** `token`'s arguments, as typed after it: { _, name?, repos[], expires?, server?, readOnly?, json?, help? }. Throws a UsageError. */
export function parseTokenArgs(argv) {
  const out = { _: [], repos: [] };
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    const eq = word.startsWith('--') ? word.indexOf('=') : -1;
    const flag = eq > 2 ? word.slice(0, eq) : word;
    if (Object.hasOwn(SWITCHES, flag)) {
      if (eq > 2) throw new UsageError(`${flag} takes no value`);
      out[SWITCHES[flag]] = true;
    } else if (Object.hasOwn(VALUES, flag)) {
      const value = eq > 2 ? word.slice(eq + 1) : argv[++i];
      if (value === undefined || (eq <= 2 && value.startsWith('--'))) throw new UsageError(`${flag} needs a value`);
      if (flag === '--repo') out.repos.push(...value.split(',').map((r) => r.trim()).filter(Boolean));
      else if (Object.hasOwn(out, VALUES[flag])) throw new UsageError(`${flag} is given twice`);
      else out[VALUES[flag]] = value;
    } else if (word.startsWith('-') && word !== '-') {
      throw new UsageError(`unknown option ${word}`);
    } else {
      out._.push(word);
    }
  }
  return out;
}

/**
 * --expires as the server takes it: a number of days, null for never, or
 * undefined when it was not given (the server's default, 90 days). Never is
 * only ever what was asked for, word for word.
 */
export function expiresInDays(value) {
  if (value === undefined) return undefined;
  const said = String(value).trim().toLowerCase();
  if (said === 'never') return null;
  const days = /^\d{1,3}d?$/.test(said) ? Number.parseInt(said, 10) : Number.NaN;
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new UsageError(`--expires takes days from 1 to ${MAX_DAYS} (30d, 90d), or never`);
  }
  return days;
}

/** The repositories a token is held to, as owner/name, or null for all of them. */
export function reposOf(repos) {
  if (!repos.length) return null;
  const bad = repos.find((r) => !REPO.test(r.toLowerCase()));
  if (bad) throw new UsageError(`--repo takes a repository as owner/name, not ${JSON.stringify(bad)}`);
  const named = [...new Set(repos.map((r) => r.toLowerCase()))];
  if (named.length > REPOS_MAX) throw new UsageError(`--repo names ${named.length} repositories: a token is held to ${REPOS_MAX} at most`);
  return named;
}

/**
 * --name, or "cli" and today's date, so a list says how and when each token
 * was made. Never this computer's name, which is often its owner's: the site
 * says the hostname leaves the machine only inside an HMAC, and the server
 * keeps a token's name for as long as it keeps the token. Held to the
 * server's rule (api-tokens.ts), the same pattern: characters, not UTF-16
 * units, and nothing that hides or reorders text when it is listed. The
 * zero-width joiner stays, as it does there, for the emoji it builds.
 */
export function nameOf(value, now = new Date()) {
  const name = (value ?? `cli ${now.toISOString().slice(0, 10)}`).trim();
  if (!name || [...name].length > NAME_MAX || /\p{Cc}|(?!\u200D)\p{Cf}/u.test(name)) {
    throw new UsageError(`--name takes 1 to ${NAME_MAX} characters, on one line, and none that hide or reorder text`);
  }
  return name;
}

// ── the sign-in, and the server ─────────────────────────────────────────────

const loginFile = () => path.join(process.env.AGENTMASH_HOME || os.homedir(), '.agentmash', 'user.json');

/** This machine's sign-in ({ url, token, login }), or null. */
function readLogin() {
  try {
    const parsed = JSON.parse(fs.readFileSync(loginFile(), 'utf8'));
    return typeof parsed?.token === 'string' && parsed.token && typeof parsed?.url === 'string' && parsed.url ? parsed : null;
  } catch {
    return null;
  }
}

const bare = (url) => String(url).replace(/\/+$/, '');

/** The server the sign-in came from; --server only to say which that is. */
function serverOf(args, login) {
  const url = bare(login.url);
  if (args.server !== undefined && bare(args.server) !== url) {
    fail(
      `this machine is signed in to ${url}, not ${clean(args.server)}: a token is made with the sign-in, where it was given — ` +
        `npx agentmash login --server ${clean(bare(args.server))} signs in there`
    );
  }
  return url;
}

/** One request with the sign-in as a Bearer token: { status, json, text, location }. Never throws. */
async function call(method, url, token, body) {
  try {
    // Node gives each address a hostname resolves to 250 ms to connect, by
    // default; a server a continent away takes longer (see agentmash.mjs).
    net.setDefaultAutoSelectFamilyAttemptTimeout?.(Math.floor(REQUEST_TIMEOUT_MS / 2));
  } catch {
    // a Node without the knob has no such default either
  }
  try {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        connection: 'close',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // a redirect would carry the sign-in somewhere it was not given
      redirect: 'manual',
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON: an old server's HTML page, or a proxy's
    }
    return { status: res.status, json, text, location: res.headers.get('location'), retryAfter: res.headers.get('retry-after') };
  } catch (err) {
    return { status: 0, json: null, text: String(err?.cause?.message || err?.message || err) };
  }
}

/** Why a request did not do what it was for, in words to act on. */
function trouble(res, server) {
  const code = typeof res.json?.code === 'string' ? res.json.code : '';
  const said = typeof res.json?.error === 'string' ? clean(res.json.error) : '';
  if (res.status === 0) return `could not reach ${server}\n        ${e.dim(clean(res.text))}`;
  if (res.status >= 300 && res.status < 400) {
    return `${server} sent this request on to ${clean(res.location || 'somewhere else')} (HTTP ${res.status}); agentmash does not send your sign-in after it`;
  }
  // an unknown route, from a server older than tokens: Fastify's own 404, or ours (app.ts, "no such route")
  if (res.status === 404 && (!res.json || said === 'no such route' || said === 'Not Found')) {
    return `${server} has no API tokens: it is older than this CLI`;
  }
  if (res.status === 401 && code === 'reauth') return REAUTH;
  if (res.status === 401) return `this machine's sign-in has expired or was revoked — run: npx agentmash login`;
  if (res.status === 429) {
    // the server's own sentence says when, as a token's limit is by the hour
    if (said) return said;
    const wait = Number.parseInt(res.retryAfter ?? '', 10);
    return `too many requests${Number.isFinite(wait) && wait > 0 ? ` — try again in ${wait}s` : ''}`;
  }
  if (res.status === 409) {
    return `${said || 'this account has as many tokens as it can: revoke one first'} — npx agentmash token list shows them`;
  }
  return said ? `${said}${code ? ` (${code})` : ''}` : `${server} answered HTTP ${res.status}`;
}

// ── what a token is, in words ───────────────────────────────────────────────

const day = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : '?');
const canWrite = (t) => Array.isArray(t.scopes) && t.scopes.includes('write');
const scopeText = (t) => (canWrite(t) ? 'read and write' : 'read only');
const repoList = (t) => (Array.isArray(t.repos) && t.repos.length ? t.repos.map(clean).join(', ') : null);
function expiryText(t, now) {
  if (!t.expires_at) return 'never expires';
  const at = Date.parse(t.expires_at);
  return `${Number.isFinite(at) && at <= now ? 'expired' : 'expires'} ${day(t.expires_at)}`;
}
const usedText = (t) => (t.last_used ? `last used ${day(t.last_used)}` : 'never used');

// ── the commands ────────────────────────────────────────────────────────────

async function create(args, server, login) {
  const name = nameOf(args.name);
  const repos = reposOf(args.repos);
  const days = expiresInDays(args.expires);
  const body = {
    name,
    scopes: args.readOnly ? ['read'] : ['read', 'write'],
    ...(repos ? { repos } : {}),
    ...(days === undefined ? {} : { expires_in_days: days }),
  };
  const res = await call('POST', `${server}/api/v1/tokens`, login.token, body);
  if (res.status !== 200 && res.status !== 201) fail(trouble(res, server));
  const made = res.json;
  if (typeof made?.token !== 'string' || !made.token) fail(`${server} made a token but did not say what it is: revoke it (npx agentmash token list) and try again`);
  if (args.json) {
    console.log(JSON.stringify(made, null, 2));
    return;
  }
  const said = (s) => console.error(s);
  said('');
  said(`  ${e.green('✓')} made ${e.bold(clean(made.name ?? name))}  ${e.dim(clean(made.id ?? ''))}`);
  said(`      ${[scopeText(made), repoList(made) ?? 'every repository you can push to', expiryText(made, Date.now())].join(' · ')}`);
  said('');
  // alone on stdout: what $(...) captures
  console.log(made.token);
  said('');
  said(`  ${e.yellow('!')} copy it now: it is shown this once, and never again`);
  said(`  ${e.dim('·')} send it to ${server}/api/v1 as ${e.bold('Authorization: Bearer amp_…')}, and name a room by its ref, x-agentmash-room: rm_…`);
  said(`  ${e.dim('·')} it pauses once your GitHub sign-in is 30 days old, until you sign in again: for CI, use the room key`);
  // a key from a public repository opens its room only beside a sign-in, which pauses the same way (room_key_public)
  said(`  ${e.dim('·')} unless the room's repository is public on GitHub: there the key, too, needs a sign-in beside it that is under 30 days old`);
  said('');
}

async function tokensOf(server, login) {
  const res = await call('GET', `${server}/api/v1/tokens`, login.token);
  if (res.status !== 200 || !Array.isArray(res.json?.tokens)) fail(trouble(res, server));
  return res.json.tokens.filter((t) => t && typeof t === 'object');
}

async function list(args, server, login) {
  const tokens = await tokensOf(server, login);
  if (args.json) {
    console.log(JSON.stringify({ tokens }, null, 2));
    return;
  }
  console.log(`\n${c.bold('agentmash tokens')}  ${c.dim(`${clean(login.login || '?')} · ${server}`)}\n`);
  if (tokens.length === 0) {
    console.log(`  none yet — make one: ${c.bold('npx agentmash token create --name <name>')}\n`);
    return;
  }
  const now = Date.now();
  const rows = tokens.map((t) => [
    clean(t.id ?? '?'),
    clean(t.name ?? ''),
    scopeText(t),
    repoList(t) ?? 'all repositories',
    usedText(t),
    t.revoked_at ? `revoked ${day(t.revoked_at)}` : expiryText(t, now),
  ]);
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  for (const row of rows) {
    const [id, ...rest] = row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i])));
    console.log(`  ${c.cyan(id)}  ${rest.join('  ')}`.trimEnd());
  }
  console.log(c.dim(`\n  revoke one: npx agentmash token revoke <id>\n`));
}

async function revoke(args, server, login) {
  const [, which] = args._;
  if (!which || args._.length > 2) throw new UsageError('say which token: npx agentmash token revoke <tok_…|name>');
  let id = which;
  let name = null;
  if (!TOKEN_ID.test(which)) {
    // by name, when exactly one live token goes by it
    const named = (await tokensOf(server, login)).filter((t) => t.name === which && !t.revoked_at);
    if (named.length === 0) fail(`no token is named ${JSON.stringify(which)} — npx agentmash token list shows them`);
    if (named.length > 1) {
      fail(`${named.length} tokens are named ${JSON.stringify(which)}: revoke one by its id (${named.map((t) => clean(t.id)).join(', ')})`);
    }
    id = String(named[0].id ?? '');
    name = which;
    if (!TOKEN_ID.test(id)) fail(`${server} listed a token with no id to revoke it by`);
  }
  const res = await call('DELETE', `${server}/api/v1/tokens/${encodeURIComponent(id)}`, login.token);
  if (res.status === 404 && res.json && !['no such route', 'Not Found'].includes(res.json.error)) {
    fail(`no token ${id} on this account — npx agentmash token list shows them`);
  }
  if (res.status !== 200 && res.status !== 204) fail(trouble(res, server));
  const revoked = res.json?.revoked !== false;
  if (args.json) {
    console.log(JSON.stringify({ id, revoked }, null, 2));
    return;
  }
  const what = name ? `${id} (${clean(name)})` : id;
  console.log(`\n  ${c.green('✓')} ${revoked ? `revoked ${what}: it opens nothing from now on` : `${what} was revoked already`}\n`);
}

const ACTIONS = { create, list, revoke };

/** `npx agentmash token …`, given the words after `token`. */
export async function cmdToken(argv) {
  let args;
  try {
    args = parseTokenArgs(argv);
    const [action] = args._;
    if (args.help || !action) {
      console.log(USAGE);
      return;
    }
    if (!Object.hasOwn(ACTIONS, action)) throw new UsageError(`unknown token command: ${action}`);
    if (action !== 'revoke' && args._.length > 1) throw new UsageError(`unexpected ${JSON.stringify(args._[1])}`);
    // nothing is sent anywhere until every argument reads
    if (action === 'create') {
      nameOf(args.name);
      reposOf(args.repos);
      expiresInDays(args.expires);
    } else if (args.name !== undefined || args.repos.length || args.expires !== undefined || args.readOnly) {
      throw new UsageError(`--name, --repo, --expires and --read-only are for token create`);
    }
    const login = readLogin();
    if (!login) fail('this machine is not signed in — run npx agentmash login first: a token is made with that sign-in');
    const server = serverOf(args, login);
    await ACTIONS[action](args, server, login);
  } catch (err) {
    if (err instanceof Failure) console.error(`\n${e.red('error')} ${err.message}\n`);
    else if (err instanceof UsageError) {
      console.error(`\n${e.red('error')} ${err.message}`);
      console.error(USAGE);
    } else throw err;
    process.exitCode = 1;
  }
}
