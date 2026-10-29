// `npx agentmash ask` and `npx agentmash inbox`: prompt your teammate's agent,
// the way that works with every agent. A person sends a teammate a request
// for their agent; the teammate sees it here and on the dashboard, and their
// own agent is given one line about it when their next session starts, or at
// a prompt within ten minutes, in agents whose hooks pass context to the
// model (docs/ADAPTERS.md), and in Claude Code also after its next edit.
// They say yes or no. Yes gives them its text to
// paste into their own agent themselves: nothing is ever sent into anyone's
// agent, and the person who runs it is its author, on their own account.
//
// Yes, no and reading one whole are the person's own: from an agent's shell
// (agentShell) they are refused, so no agent answers a request for them or
// takes its text in as its next input. Yes asks for more than that, since a
// shell no marker names is still an agent's: a code shown on the person's own
// terminal, typed back there (confirmedAtTerminal).
//
//   npx agentmash ask teammate "text" [--session ls_…] [--ttl <minutes>] [--json]
//   npx agentmash inbox [--all] [--json]
//   npx agentmash inbox show <id>
//   npx agentmash inbox accept <id>
//   npx agentmash inbox deny <id> [reason]
//   npx agentmash inbox cancel <id>
//
// Both go through the room this checkout reports to, by its ref, with this
// machine's sign-in (`npx agentmash login`): the server knows who sent what
// from that, and only someone who can push to the room's repository sends,
// receives or answers. A request sent from here is always a suggestion, read
// only. The sign-in goes only to the server the room is on.
//
// What a person accepts is printed alone on stdout, so `npx agentmash inbox
// accept <id> > prompt.txt` keeps it and nothing else; everything said around
// it goes to stderr. Like token.mjs, this file reads its own arguments.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import tty from 'node:tty';

const REQUEST_TIMEOUT_MS = 10_000;
/** A GitHub login, as the server takes one. */
const LOGIN = /^[a-z0-9][a-z0-9-]{0,38}$/;
const MESSAGE_ID = /^msg_[A-Za-z0-9_-]{22}$/;
const SESSION_ID = /^ls_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The server's limits (lobby-contract.ts, INBOX_LIMITS). */
const BODY_MAX_CHARS = 32_000;
const TTL_MAX_MINUTES = 1440;
const REASON_MAX_CHARS = 300;
/** Requests to you that wait for an answer. */
const WAITING = new Set(['pending', 'held_for_approval']);
/** How much of a request the list shows; inbox show has all of it. */
const PREVIEW_CHARS = 240;
/** How much of the server's word on how a request is seen ask prints. */
const DELIVERY_CHARS = 400;
/** Requests you sent, listed without --all. */
const SENT_SHOWN = 10;

const ASK_USAGE = `
  npx agentmash ask teammate "what you want their agent to do" [--session ls_…] [--ttl <minutes>] [--json]
      send a teammate in this repository's room a request for their agent: a suggestion, read only.
      nothing runs until they say yes, and then they paste it into their own agent themselves.
      teammate is their GitHub login, with no @: PowerShell drops a word that starts with one
        --session   one of their lobby sessions, by id (default: whichever they choose)
        --ttl       minutes it waits for an answer, 1 to 1440 (default 60)
`;

const INBOX_USAGE = `
  npx agentmash inbox [--all] [--json]
      requests waiting for you in this repository's room, and the ones you sent, with where each is
  npx agentmash inbox show <id>
      the whole text of one, and what happened to it
  npx agentmash inbox accept <id>
      say yes, with the code it shows you: you get its text to paste into your own agent yourself, and it is marked done
  npx agentmash inbox deny <id> [reason]
      say no, with a reason if you like
  npx agentmash inbox cancel <id>
      take back one you sent, while it waits

  show, accept and deny run in your own terminal, never in an agent's
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
  yellow: paint(outColour, 33),
  cyan: paint(outColour, 36),
};
const e = {
  bold: paint(errColour, 1),
  dim: paint(errColour, 2),
  green: paint(errColour, 32),
  yellow: paint(errColour, 33),
  red: paint(errColour, 31),
  cyan: paint(errColour, 36),
};
const say = (line = '') => console.error(line);

/**
 * What coding agents set in the shells they run commands in, by agent, where
 * known. Run there, accept would be the agent saying yes for the person, and
 * the teammate's text would land on its stdout as its next input. A terminal
 * check cannot tell (Git Bash's mintty has no TTY); these can.
 */
export const AGENT_SHELL_MARKERS = [
  'CLAUDECODE', // Claude Code
  'CLAUDE_CODE_ENTRYPOINT', // Claude Code
  'AI_AGENT', // Claude Code, Crush, OpenHands
  'AGENT', // Amp, Crush
  'CODEX_SANDBOX', // Codex, sandboxed
  'CODEX_SANDBOX_NETWORK_DISABLED', // Codex, sandboxed
  'CURSOR_AGENT', // Cursor's agent
  'GEMINI_CLI', // Gemini CLI
  'QWEN_CODE', // Qwen Code
  'AGENTMASH_LOBBY_SESSION', // any session the desktop app runs
];

/** The marker that says this runs in an agent's shell, or null in a person's own terminal. */
export function agentShell(env = process.env) {
  return (
    AGENT_SHELL_MARKERS.find((name) => {
      const value = String(env[name] ?? '').trim().toLowerCase();
      return value !== '' && value !== '0' && value !== 'false';
    }) ?? null
  );
}

/** Where a person answers a request when the command runs in an agent's shell. */
const OWN_TERMINAL = 'run this in your own terminal or accept it on the dashboard: an agent never answers a teammate request for you';

/**
 * Taken by hand (npx agentmash inbox accept, the dashboard): done, approved
 * by_hand, into no session on no machine. One a lobby daemon delivered says
 * by_hand false.
 */
export function takenByHand(m) {
  return m?.state === 'done' && m.approved?.by_hand === true;
}

// ── yes, at the person's own terminal ───────────────────────────────────────
//
// The markers above name the agents known to set one, and an agent that sets
// none (opencode, goose, Copilot CLI, Aider) would accept for the person, and
// the server would record that as done by hand. So yes is a code shown on the
// person's own terminal and typed back there. An agent that just runs the
// command reads its stdout and stderr and writes its stdin; it never sees that
// terminal, so it has no code to type, and a shell with no terminal behind it
// has nowhere to show one. That is all this stops: an agent that runs the
// command inside a terminal of its own (script, expect, a pty library) reads
// the code there and types it back, and one that calls the API with this
// machine's sign-in needs no code at all. A confirmation the server asks for
// (the dashboard's code) is what would close those. The markers stay, so an
// agent known to be one is told at once.

/** How long accept waits for the code. */
const CONFIRM_MS = 120_000;
/** Letters nobody misreads for a digit or for each other. */
const CODE_LETTERS = 'abcdefghjkmnpqrstuvwxyz';
const CODE_LENGTH = 4;

/** A code to type back, new for every accept. */
export function confirmCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
  return code;
}

/**
 * The terminal of the person who ran this, apart from this command's stdin,
 * stdout and stderr: /dev/tty, the controlling terminal, where there is one.
 * On Windows, the console, and only while stdin is that console: an agent's
 * pipes and Git Bash's mintty come with a console nobody sees, where a code
 * would wait for an answer nobody can give. `{ say(text), line(ms), close() }`,
 * where `line` resolves with what was typed up to Enter, or null when nothing
 * was in `ms`; null when there is no such terminal.
 */
export function ownTerminal() {
  if (process.platform === 'win32') {
    if (!process.stdin.isTTY) return null;
    let out;
    try {
      // the device path: node makes a bare 'CONOUT$' an absolute \\?\ path,
      // which is a plain file in the current folder, not the console
      out = fs.openSync('\\\\.\\CONOUT$', 'w');
    } catch {
      return null;
    }
    return lineTerminal(process.stdin, out);
  }
  let input;
  let out;
  try {
    input = fs.openSync('/dev/tty', 'r');
    out = fs.openSync('/dev/tty', 'w');
    if (!tty.isatty(input)) throw new Error('not a terminal');
  } catch {
    for (const fd of [input, out]) {
      try {
        if (fd !== undefined) fs.closeSync(fd);
      } catch {
        // closed already
      }
    }
    return null;
  }
  return lineTerminal(new tty.ReadStream(input), out);
}

/** A terminal read from `stream` a line at a time, and written to through the descriptor `out`. */
function lineTerminal(stream, out) {
  return {
    say(text) {
      try {
        fs.writeSync(out, text);
      } catch {
        // a terminal that went away: nothing typed there either, and line() says so
      }
    },
    line(ms) {
      return new Promise((resolve) => {
        let typed = '';
        const done = (value) => {
          clearTimeout(timer);
          stream.off('data', onData);
          stream.off('end', onEnd);
          resolve(value);
        };
        const onData = (chunk) => {
          typed += String(chunk);
          const end = typed.search(/[\r\n]/);
          if (end >= 0) done(typed.slice(0, end));
        };
        const onEnd = () => done(null);
        const timer = setTimeout(() => done(null), ms);
        stream.on('data', onData);
        stream.on('end', onEnd);
        stream.resume();
      });
    },
    close() {
      // read once and done: nothing keeps the command open after it
      stream.destroy();
      try {
        fs.closeSync(out);
      } catch {
        // closed already
      }
    },
  };
}

/**
 * Whether the person says yes to accepting `id` at `terminal` (ownTerminal):
 * 'yes' when they typed the code shown there, 'no' when they typed anything
 * else, 'none' when nothing came in time. The code is said on that terminal
 * only, never on stdout or stderr.
 */
export async function confirmedAtTerminal(id, terminal, { timeoutMs = CONFIRM_MS, code = confirmCode() } = {}) {
  try {
    terminal.say(
      `\n  accept ${id}? only you can say yes to it, here at your own terminal.\n` +
        `  type ${code} and press enter to accept it, or anything else to leave it waiting: `
    );
    const typed = await terminal.line(timeoutMs);
    if (typed === null) return 'none';
    return typed.trim().toLowerCase() === code ? 'yes' : 'no';
  } finally {
    terminal.close();
  }
}

class UsageError extends Error {}
/** What fail() throws, for the command to say. */
class Failure extends Error {}

/**
 * End the command with `message`: printed, and exit code 1, never by
 * process.exit() (see die in agentmash.mjs).
 */
function fail(message) {
  throw new Failure(message);
}

/** Text a server or a teammate sent, safe to print on a line: no escape sequence or line break of its own. */
const clean = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

/** A teammate's text as the start of it, on one line, for a list. */
function preview(text, max = PREVIEW_CHARS) {
  const line = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...line];
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * What the server says of how and when a teammate sees a request you sent
 * (POST /api/v1/lobby/inbox's `delivery.text`: their app open, closed, or
 * the CLI only), on one line with nothing in it that moves the cursor or
 * turns the words around (control and format characters), or null where it
 * said nothing.
 */
function deliveryLine(delivery) {
  const line = typeof delivery?.text === 'string' ? preview(delivery.text.replace(/\p{Cf}/gu, ''), DELIVERY_CHARS) : '';
  return line || null;
}

/**
 * A teammate's whole text, to print for the person to read or paste: every
 * line kept, and no terminal escape sequence or other control character that
 * could hide part of it or move the cursor over it. Tabs and line breaks stay.
 */
function printable(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

// ── arguments ───────────────────────────────────────────────────────────────

const VALUES = { '--session': 'session', '--ttl': 'ttl', '--repo': 'repo' };
const SWITCHES = { '--json': 'json', '--all': 'all', '--help': 'help', '-h': 'help' };

/** The words after `ask` or `inbox`: { _, session?, ttl?, repo?, json?, all?, help? }. Throws a UsageError. */
export function parseInboxArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    // `--` alone: everything after it is words, whatever they look like
    if (word === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    const eq = word.startsWith('--') ? word.indexOf('=') : -1;
    const flag = eq > 2 ? word.slice(0, eq) : word;
    if (Object.hasOwn(SWITCHES, flag)) {
      if (eq > 2) throw new UsageError(`${flag} takes no value`);
      out[SWITCHES[flag]] = true;
    } else if (Object.hasOwn(VALUES, flag)) {
      const value = eq > 2 ? word.slice(eq + 1) : argv[++i];
      if (value === undefined || (eq <= 2 && value.startsWith('--'))) throw new UsageError(`${flag} needs a value`);
      if (Object.hasOwn(out, VALUES[flag])) throw new UsageError(`${flag} is given twice`);
      out[VALUES[flag]] = value;
    } else if (/^--[a-z][a-z-]*(=|$)/.test(word)) {
      throw new UsageError(`unknown option ${word.split('=')[0]}`);
    } else {
      // a request's own words may start with dashes ("-- not that file", "-v is broken"): only --name is an option
      out._.push(word);
    }
  }
  return out;
}

/** `ask`'s request body, from its arguments: { to, body, mode, scope, ttl_minutes }. Throws a UsageError. */
export function askBody(args) {
  const [who, ...words] = args._;
  if (!who) throw new UsageError('say who: npx agentmash ask teammate "what you want their agent to do"');
  // An @ in front is fine where it reaches us, but the examples leave it off:
  // PowerShell reads @dana as a variable to splat, and with no $dana passes
  // nothing at all, so the request's own words arrive where the login should be.
  const to = who.replace(/^@/, '').toLowerCase();
  // One word and nothing after it is how `ask @dana fix` arrives from
  // PowerShell, where `fix` reads as a login just as well: said either way.
  const dropped =
    words.length === 0 ? '\n      in PowerShell a word that starts with @ never reaches the command: type the login without it' : '';
  if (!LOGIN.test(to)) {
    throw new UsageError(`${JSON.stringify(who)} is not a GitHub login: npx agentmash ask teammate "…"${dropped}`);
  }
  const body = words.join(' ').trim();
  if (!body) throw new UsageError(`say what you want ${to}'s agent to do: npx agentmash ask ${to} "…"${dropped}`);
  if ([...body].length > BODY_MAX_CHARS) throw new UsageError(`a request is at most ${BODY_MAX_CHARS} characters`);
  if (args.session !== undefined && !SESSION_ID.test(args.session)) {
    throw new UsageError('--session takes the id of one of their lobby sessions, ls_ and a uuid');
  }
  let ttl;
  if (args.ttl !== undefined) {
    ttl = /^\d{1,4}$/.test(args.ttl) ? Number(args.ttl) : NaN;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > TTL_MAX_MINUTES) throw new UsageError(`--ttl takes minutes, 1 to ${TTL_MAX_MINUTES}`);
  }
  return {
    to: { user: to, session_id: args.session ?? null },
    body,
    // from here, always the narrowest: a draft for them to read, that only reads
    mode: 'suggest',
    scope: 'read_only',
    ...(ttl === undefined ? {} : { ttl_minutes: ttl }),
  };
}

// ── the server ──────────────────────────────────────────────────────────────

/** One request with the sign-in as a Bearer token and the room by its ref: { status, json, text }. Never throws. */
async function call(room, method, pathAndQuery, body) {
  try {
    // Node gives each address a hostname resolves to 250 ms to connect, by
    // default; a server a continent away takes longer (see agentmash.mjs).
    net.setDefaultAutoSelectFamilyAttemptTimeout?.(Math.floor(REQUEST_TIMEOUT_MS / 2));
  } catch {
    // a Node without the knob has no such default either
  }
  try {
    const res = await fetch(`${room.server}${pathAndQuery}`, {
      method,
      headers: {
        authorization: `Bearer ${room.token}`,
        'x-agentmash-room': room.ref,
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
      // not JSON: an old server's page, or a proxy's
    }
    return { status: res.status, json, text, location: res.headers.get('location'), retryAfter: res.headers.get('retry-after') };
  } catch (err) {
    return { status: 0, json: null, text: String(err?.cause?.message || err?.message || err) };
  }
}

/** Why a request did not do what it was for, in words to act on. */
function trouble(res, room, { id } = {}) {
  const code = typeof res.json?.code === 'string' ? res.json.code : '';
  const said = typeof res.json?.error === 'string' ? clean(res.json.error) : '';
  if (res.status === 0) return `could not reach ${room.server}\n        ${e.dim(clean(res.text))}`;
  if (res.status >= 300 && res.status < 400) {
    return `${room.server} sent this request on to ${clean(res.location || 'somewhere else')} (HTTP ${res.status}); agentmash does not send your sign-in after it`;
  }
  // an unknown route, from a server older than the inbox: Fastify's own 404, or ours
  if (res.status === 404 && (!res.json || said === 'no such route' || said === 'Not Found' || /^Route \w+:/.test(said))) {
    return `${room.server} has no teammate inbox: it is older than this CLI`;
  }
  if (res.status === 404 && code === 'not_found' && id) {
    return `no request ${id} here that was sent to you or by you — npx agentmash inbox lists them`;
  }
  if (res.status === 401 && code === 'reauth') {
    return 'GitHub has to say again what you can push to: run npx agentmash login, then try again';
  }
  if (res.status === 401) return `this machine's sign-in has expired or was revoked, or it no longer opens this room — run: npx agentmash login`;
  if (res.status === 429 && !said) {
    const wait = Number.parseInt(res.retryAfter ?? '', 10);
    return `too many requests${Number.isFinite(wait) && wait > 0 ? ` — try again in ${wait}s` : ''}`;
  }
  return said ? `${said}${code ? ` (${code})` : ''}` : `${room.server} answered HTTP ${res.status}`;
}

// ── what a request is, in words ─────────────────────────────────────────────

function ago(iso, now = Date.now()) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '?';
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function until(iso, now = Date.now()) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'later';
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return 'now';
  return minutes < 60 ? `in ${minutes} min` : `in ${Math.round(minutes / 60)} h`;
}

const SCOPE_TEXT = { read_only: 'read only', edit: 'may edit', 'edit+exec': 'may edit and run commands' };
const scopeText = (m) => SCOPE_TEXT[m?.scope] ?? clean(m?.scope ?? '?');

/** Where a request is, said from the side of `you`. */
export function stateText(m, you) {
  const to = m.to?.user === you ? 'you' : clean(m.to?.user ?? '?');
  switch (m.state) {
    case 'pending':
    case 'held_for_approval':
      return to === 'you' ? 'waiting for you' : `waiting for ${to}`;
    case 'approved':
      return `approved by ${to}, on its way to ${to === 'you' ? 'your' : 'their'} agent`;
    case 'delivered':
    case 'running':
      return `with ${to === 'you' ? 'your' : `${to}'s`} agent`;
    case 'done':
      return takenByHand(m) ? `taken by ${to}, to run in ${to === 'you' ? 'your' : 'their'} own agent` : 'done';
    case 'denied': {
      const why = m.denied?.reason ? `: "${preview(m.denied.reason, 120)}"` : '';
      return `${to === 'you' ? 'you' : to} said no${why}`;
    }
    case 'expired':
      return 'expired: nobody answered in time';
    case 'failed':
      return m.failure?.code === 'canceled' ? 'taken back' : `failed (${clean(m.failure?.code ?? 'other')})`;
    default:
      return clean(m.state ?? '?');
  }
}

// ── the commands ────────────────────────────────────────────────────────────

/** The room, or the reason there is none, from agentmash.mjs (inboxRoom). */
async function roomFor(args, ctx) {
  const room = await ctx.roomOf(args.repo);
  if (room?.problem) fail(room.problem);
  if (!room?.server || !room?.ref || !room?.token) fail('could not tell which room this checkout reports to — npx agentmash doctor says why');
  if (!room.login) {
    // a sign-in kept from before it named its login: the server says whose it is
    const me = await call(room, 'GET', '/api/v1/me');
    if (me.status !== 200 || typeof me.json?.login !== 'string') fail(trouble(me, room));
    return { ...room, login: me.json.login.toLowerCase() };
  }
  return { ...room, login: String(room.login).toLowerCase() };
}

async function ask(args, ctx) {
  const body = askBody(args);
  const room = await roomFor(args, ctx);
  if (room.login && body.to.user === room.login.toLowerCase()) throw new UsageError('that is you: send it to a teammate');
  const res = await call(room, 'POST', '/api/v1/lobby/inbox', body);
  if (res.status !== 201 && res.status !== 200) fail(trouble(res, room));
  const m = res.json?.message;
  if (!m || typeof m.id !== 'string') fail(`${room.server} took the request but did not say what it is: npx agentmash inbox lists what you sent`);
  if (args.json) {
    console.log(JSON.stringify(m, null, 2));
    return;
  }
  const to = clean(m.to?.user ?? body.to.user);
  console.log('');
  console.log(`  ${c.green('✓')} sent ${c.bold(to)} a request for their agent  ${c.dim(clean(m.id))}`);
  console.log(`      a suggestion, ${scopeText(m)}${m.to?.session_id ? `, for their session ${clean(m.to.session_id)}` : ''} · expires ${until(m.expires_at)}`);
  console.log('');
  // how and when they see it, as the server says from whether their lobby app is open; a server from before says
  // nothing, and then these two lines say what holds without the app
  const delivery = deliveryLine(res.json?.delivery);
  if (delivery) console.log(`  ${c.dim('·')} ${delivery}`);
  else {
    console.log(`  ${c.dim('·')} they see it in npx agentmash inbox and on the dashboard; nothing runs until they accept it`);
    console.log(`  ${c.dim('·')} if ${to} accepts, they paste it into their own agent themselves, which runs it on their own account`);
  }
  console.log(`  ${c.dim('·')} where it is: ${c.bold('npx agentmash inbox')}   take it back: ${c.bold(`npx agentmash inbox cancel ${clean(m.id)}`)}`);
  console.log('');
}

async function list(args, ctx) {
  const room = await roomFor(args, ctx);
  const res = await call(room, 'GET', `/api/v1/lobby/inbox?box=all&limit=${args.all ? 100 : 50}`);
  if (res.status !== 200 || !Array.isArray(res.json?.messages)) fail(trouble(res, room));
  const you = String(room.login ?? '').toLowerCase();
  const messages = res.json.messages.filter((m) => m && typeof m.id === 'string');
  const toYou = messages.filter((m) => m.to?.user === you);
  const waiting = toYou.filter((m) => WAITING.has(m.state)).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const answered = toYou.filter((m) => !WAITING.has(m.state));
  const sent = messages.filter((m) => m.from_user === you);
  if (args.json) {
    // in an agent's shell, the start of each text, as the list shows it: the whole of one is the person's to read
    const agent = agentShell();
    const shown = (ms) => (agent ? ms.map((m) => ({ ...m, body: preview(m.body) })) : ms);
    console.log(JSON.stringify({ you, waiting: shown(waiting), answered: shown(answered), sent: shown(sent) }, null, 2));
    return;
  }
  const now = Date.now();
  console.log(`\n${c.bold('agentmash inbox')}  ${c.dim(`${clean(you || '?')} · ${clean(room.repo ?? room.ref)}`)}\n`);
  if (waiting.length === 0) console.log(`  nothing waits for you`);
  else {
    console.log(`  ${c.bold(`waiting for you (${waiting.length})`)}`);
    for (const m of waiting) {
      console.log(`  ${c.cyan(clean(m.id))}  from ${c.bold(clean(m.from_user))} · ${ago(m.created_at, now)} · expires ${until(m.expires_at, now)} · ${scopeText(m)}`);
      console.log(`      "${preview(m.body)}"`);
    }
    if (agentShell()) {
      console.log(c.dim(`\n  the user reads, accepts or declines these in their own terminal (npx agentmash inbox) or on the dashboard: an agent never answers one for them`));
    } else {
      console.log(c.dim(`\n  read one whole: npx agentmash inbox show <id>   yes: npx agentmash inbox accept <id>   no: npx agentmash inbox deny <id> [reason]`));
    }
  }
  const shownSent = args.all ? sent : sent.slice(0, SENT_SHOWN);
  if (shownSent.length) {
    console.log(`\n  ${c.bold('you sent')}`);
    for (const m of shownSent) {
      console.log(`  ${c.cyan(clean(m.id))}  to ${c.bold(clean(m.to?.user))} · ${ago(m.created_at, now)} · ${stateText(m, you)}`);
    }
    if (sent.length > shownSent.length) console.log(c.dim(`  … and ${sent.length - shownSent.length} more: npx agentmash inbox --all`));
  }
  if (args.all && answered.length) {
    console.log(`\n  ${c.bold('answered')}`);
    for (const m of answered) {
      console.log(`  ${c.cyan(clean(m.id))}  from ${c.bold(clean(m.from_user))} · ${ago(m.created_at, now)} · ${stateText(m, you)}`);
    }
  }
  console.log('');
}

/** The message `id` names, after its id was checked. */
function idOf(args, verb) {
  const id = args._[1];
  if (!id) throw new UsageError(`say which: npx agentmash inbox ${verb} <id>`);
  if (!MESSAGE_ID.test(id)) throw new UsageError(`${JSON.stringify(id)} is not a request id (msg_…): npx agentmash inbox lists them`);
  return id;
}

/** What a person is told above a teammate's text, every time it is printed. */
function framing(m) {
  const from = clean(m.from_user);
  say(`  ${e.dim('·')} it is ${from}'s words for your agent, not yours: read it before you send it, and change what you like`);
  if (m.scope === 'read_only') say(`  ${e.dim('·')} ${from} asked that it only reads: run it where your agent cannot edit (plan mode, a read-only mode)`);
  else say(`  ${e.dim('·')} ${from} asked that it ${scopeText(m)}: it runs with the permissions you give your agent, on your own account`);
}

async function show(args, ctx) {
  const id = idOf(args, 'show');
  const room = await roomFor(args, ctx);
  const res = await call(room, 'GET', `/api/v1/lobby/inbox/${id}`);
  if (res.status !== 200 || !res.json?.message) fail(trouble(res, room, { id }));
  const m = res.json.message;
  if (args.json) {
    console.log(JSON.stringify(m, null, 2));
    return;
  }
  const you = String(room.login ?? '').toLowerCase();
  say('');
  say(`  ${e.cyan(clean(m.id))}  ${m.from_user === you ? `to ${e.bold(clean(m.to?.user))}` : `from ${e.bold(clean(m.from_user))}`} · ${ago(m.created_at)} · ${scopeText(m)} · ${stateText(m, you)}`);
  if (m.from_user !== you) framing(m);
  say(e.dim('  ─────'));
  console.log(printable(m.body));
  say(e.dim('  ─────'));
  for (const h of Array.isArray(m.history) ? m.history : []) say(e.dim(`  ${clean(h.state)} · ${clean(h.by)} · ${ago(h.at)}`));
  if (WAITING.has(m.state) && m.to?.user === you) say(`\n  yes: ${e.bold(`npx agentmash inbox accept ${clean(m.id)}`)}   no: ${e.bold(`npx agentmash inbox deny ${clean(m.id)} [reason]`)}`);
  say('');
}

async function accept(args, ctx) {
  const id = idOf(args, 'accept');
  if (args._.length > 2) throw new UsageError(`unexpected ${JSON.stringify(args._[2])}`);
  // yes is typed at the person's own terminal, before the server is asked anything
  const terminal = (ctx.terminal ?? ownTerminal)();
  if (!terminal) {
    fail(
      `there is no terminal of yours here to say yes at, so nothing was accepted: it still waits for you. ` +
        `run it in your own terminal, or accept it on the dashboard (in Git Bash's own window: winpty npx agentmash inbox accept ${id})`
    );
  }
  const said = await confirmedAtTerminal(id, terminal);
  if (said === 'none') fail(`no answer at your terminal in ${CONFIRM_MS / 60_000} minutes, so nothing was accepted: it still waits for you`);
  if (said !== 'yes') fail('that was not the code, so nothing was accepted: it still waits for you');
  const room = await roomFor(args, ctx);
  const res = await call(room, 'POST', `/api/v1/lobby/inbox/${id}/accept`, {});
  if (res.status !== 200 || !res.json?.message) fail(trouble(res, room, { id }));
  const m = res.json.message;
  if (!takenByHand(m)) {
    fail(`it is ${stateText(m, String(room.login ?? '').toLowerCase())} now, so there is nothing to paste: npx agentmash inbox show ${clean(m.id)}`);
  }
  if (args.json) {
    console.log(JSON.stringify(m, null, 2));
    return;
  }
  say('');
  say(`  ${e.green('✓')} accepted ${e.bold(clean(m.from_user))}'s request ${e.dim(clean(m.id))}: marked done, and ${clean(m.from_user)} sees you took it`);
  say(`  ${e.dim('·')} paste the text below into your own agent yourself: nothing was sent to it, and nothing runs until you do`);
  framing(m);
  say(e.dim('  ─────'));
  // alone on stdout: what `> prompt.txt` keeps
  console.log(printable(m.body));
  say(e.dim('  ─────'));
  say('');
}

async function deny(args, ctx) {
  const id = idOf(args, 'deny');
  const reason = args._.slice(2).join(' ').trim();
  if ([...reason].length > REASON_MAX_CHARS) throw new UsageError(`a reason is at most ${REASON_MAX_CHARS} characters`);
  const room = await roomFor(args, ctx);
  const res = await call(room, 'POST', `/api/v1/lobby/inbox/${id}/deny`, { reason: reason || null });
  if (res.status !== 200 || !res.json?.message) fail(trouble(res, room, { id }));
  const m = res.json.message;
  if (args.json) {
    console.log(JSON.stringify(m, null, 2));
    return;
  }
  console.log(`\n  ${c.green('✓')} said no to ${c.bold(clean(m.from_user))}'s request ${c.dim(clean(m.id))}${reason ? ', with your reason' : ''}: ${clean(m.from_user)} sees it\n`);
}

async function cancel(args, ctx) {
  const id = idOf(args, 'cancel');
  if (args._.length > 2) throw new UsageError(`unexpected ${JSON.stringify(args._[2])}`);
  const room = await roomFor(args, ctx);
  const res = await call(room, 'POST', `/api/v1/lobby/inbox/${id}/cancel`, {});
  if (res.status !== 200 || !res.json?.message) fail(trouble(res, room, { id }));
  const m = res.json.message;
  if (args.json) {
    console.log(JSON.stringify(m, null, 2));
    return;
  }
  console.log(`\n  ${c.green('✓')} took back your request to ${c.bold(clean(m.to?.user))} ${c.dim(clean(m.id))}: it no longer waits for them\n`);
}

const INBOX_ACTIONS = { show, accept, deny, cancel };

/** Run one command, saying a failure the way token.mjs does. */
async function guarded(usage, run) {
  try {
    await run();
  } catch (err) {
    if (err instanceof Failure) console.error(`\n${e.red('error')} ${err.message}\n`);
    else if (err instanceof UsageError) {
      console.error(`\n${e.red('error')} ${err.message}`);
      console.error(usage);
    } else throw err;
    process.exitCode = 1;
  }
}

/**
 * `npx agentmash ask …`, given the words after `ask`. `ctx.roomOf(repo)`
 * finds this checkout's room and this machine's sign-in (agentmash.mjs).
 */
export function cmdAsk(argv, ctx) {
  return guarded(ASK_USAGE, async () => {
    const args = parseInboxArgs(argv);
    if (args.help) {
      console.log(ASK_USAGE);
      return;
    }
    if (args.all) throw new UsageError('--all is for npx agentmash inbox');
    await ask(args, ctx);
  });
}

/** `npx agentmash inbox …`, given the words after `inbox`. */
export function cmdInbox(argv, ctx) {
  return guarded(INBOX_USAGE, async () => {
    const args = parseInboxArgs(argv);
    if (args.help) {
      console.log(INBOX_USAGE);
      return;
    }
    if (args.session !== undefined || args.ttl !== undefined) throw new UsageError('--session and --ttl are for npx agentmash ask');
    const [action] = args._;
    if (action === undefined || action === 'list') {
      if (args._.length > 1) throw new UsageError(`unexpected ${JSON.stringify(args._[1])}`);
      await list(args, ctx);
      return;
    }
    if (!Object.hasOwn(INBOX_ACTIONS, action)) throw new UsageError(`unknown inbox command: ${action}`);
    if (args.all) throw new UsageError('--all is for the list: npx agentmash inbox --all');
    // the person's own answer, and the teammate's whole text: never from an agent's shell, and nothing asked of the server
    const marker = action === 'cancel' ? null : agentShell();
    // the desktop app sets its marker in the person's own shell as in its agents', so it cannot tell them apart:
    // refused all the same, and said as the app's terminal, not as an agent's
    if (marker === 'AGENTMASH_LOBBY_SESSION') {
      fail(
        `this terminal is one the desktop app runs, and its agents run in them too, so a request is not answered here:` +
          ` accept or decline it in the app or on the dashboard (${marker} is set)`
      );
    }
    if (marker) fail(`${OWN_TERMINAL} (${marker} is set: this is an agent's shell)`);
    await INBOX_ACTIONS[action](args, ctx);
  });
}
