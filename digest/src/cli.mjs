// AgentMash digest -- zero dependencies, Node built-ins only.
//
//   npx agentmash digest                                  last 7 days, to your terminal
//   npx agentmash digest --since 24h --to slack --webhook https://hooks.slack.com/...
//   npx agentmash digest --to telegram --webhook <bot-token> --chat-id -100123
//   npx agentmash digest --to json | jq .hot_zones
//
// The command line, run two ways: by agentmash-digest (../agentmash-digest.mjs)
// from a checkout, and by `npx agentmash digest` (cli/digest.mjs) from the copy
// the CLI package carries, which hands it a way to find the room the way the
// rest of the CLI does (findRoom below).
//
// It reads the coordination server over HTTP and posts to a webhook. It is a
// client: nothing here runs inside the server, and a broken digest cannot slow
// anybody's agent down.

import fs from 'node:fs';
import path from 'node:path';
import { aggregate, DEFAULTS } from './aggregate.mjs';
import { render } from './render.mjs';
import { DigestError, fetchDashboardLink, fetchEvents, fetchLabel, postSlack, postTelegram } from './net.mjs';

const TARGETS = ['text', 'json', 'slack', 'telegram'];
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

/** What it is called in its help and its messages: agentmash-digest, or npx agentmash digest. */
let NAME = 'agentmash-digest';
const prefix = () => NAME.replace(/^npx /, '');

function usage(findsRoom) {
  const signedIn = findsRoom
    ? "\n                         with neither, the room this machine's sign-in finds\n                         for the repo (npx agentmash login)"
    : '';
  process.stdout.write(`
${prefix()} -- what your team's agents actually did, where they collided

  ${NAME} [--since 7d] [--to text|json|slack|telegram] [--webhook URL]

  --since <7d|24h|90m>   period to summarise, default 7d (compared with the
                         period of the same length immediately before it)
  --to <target>          text (default), json, slack, telegram
  --webhook <url>        Slack incoming webhook, or a Telegram bot token/URL
                         (env AGENTMASH_DIGEST_WEBHOOK)
  --chat-id <id>         Telegram chat id (env AGENTMASH_DIGEST_CHAT_ID)
  --dry-run              render the payload to stdout instead of posting

  --include-hints        include teammates' prompt text (off by default: a
                         prompt is somebody's verbatim words, and a channel is
                         a wider audience than the room)
  --link                 include the dashboard link: by the room's ref, which only
                         people signed in who belong to the room open; from a
                         server with no GitHub sign-in, by the room id, which is
                         the room's credential and shares it with the channel

  --hot-min-devs <n>     distinct people before a zone is hot   (${DEFAULTS.hotMinDevs})
  --hot-min-edits <n>    edits before a zone is hot             (${DEFAULTS.hotMinEdits})
  --hot-window <48h>     how close two people's edits must be   (${DEFAULTS.hotWindowHours}h)
  --pair-min-files <n>   shared files before a pair is reported (${DEFAULTS.pairMinFiles})
  --stall-days <n>       idle days before work counts stalled   (${DEFAULTS.stallDays})

  --server <url>         coordination server (default: this repo's config)
  --room <id>            room id             (default: this repo's config)${signedIn}
  --repo <path>          repo to read config from (default: enclosing git repo)
  --timeout <ms>         per-request timeout, default 10000

exit codes: 0 posted or printed, 1 network/server/webhook failure, 2 bad usage
`);
}

/** Marker for "already reported, stop unwinding" — never printed. */
class Exit extends Error {}

function report(message, code = EXIT_FAILURE, hint = null) {
  process.stderr.write(`${prefix()}: ${message}\n`);
  if (hint) process.stderr.write(`  ${hint}\n`);
  process.exitCode = code;
}

/**
 * Sets the exit code and unwinds, rather than calling process.exit().
 * Exiting outright while an HTTP socket is still closing crashes Node on
 * Windows (0xC0000409), so a failed webhook post reported a crash instead of
 * the exit code this tool documents.
 */
function die(message, code = EXIT_FAILURE, hint = null) {
  report(message, code, hint);
  throw new Exit(message);
}

const SWITCHES = new Set(['--dry-run', '--include-hints', '--link', '--help', '-h']);
const OPTIONS = new Set([
  '--since', '--to', '--webhook', '--chat-id',
  '--hot-min-devs', '--hot-min-edits', '--hot-window', '--pair-min-files', '--stall-days',
  '--server', '--room', '--repo', '--timeout',
]);

/**
 * The words after the command, `--option value` or `--option=value`. A flag
 * it does not know, a word it takes none of, or an option with nothing after
 * it is a usage mistake, said before anything is read or sent: a mistyped
 * `--dryrun` used to be dropped, and the digest posted to the channel.
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (SWITCHES.has(token)) {
      args[token.replace(/^-+/, '')] = true;
      continue;
    }
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    if (OPTIONS.has(name)) {
      const value = eq > 0 ? token.slice(eq + 1) : argv[++i];
      if (value === undefined || (eq < 0 && value.startsWith('--'))) die(`${name} needs a value`, EXIT_USAGE);
      args[name.slice(2)] = value;
      continue;
    }
    die(
      token.startsWith('-') ? `unknown option ${token} — ${NAME} --help lists them` : `unexpected "${token}": ${NAME} takes options only — ${NAME} --help lists them`,
      EXIT_USAGE
    );
  }
  return args;
}

/** "7d", "48h", "90m", or a bare number of days -> minutes. */
function parseDuration(value, what) {
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*([dhm]?)$/i);
  if (!m) die(`${what} must look like 7d, 48h or 90m (got "${value}")`, EXIT_USAGE);
  const n = Number(m[1]);
  if (!(n > 0)) die(`${what} must be greater than zero`, EXIT_USAGE);
  const unit = (m[2] || 'd').toLowerCase();
  return unit === 'm' ? n : unit === 'h' ? n * 60 : n * 1440;
}

function integer(value, fallback, what) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) die(`${what} must be a whole number of at least 1`, EXIT_USAGE);
  return n;
}

function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Same precedence the hooks and the CLI use: flags, then env, then the committed config. */
function resolveRoom(args) {
  const repo = args.repo ? path.resolve(args.repo) : findRepoRoot(process.cwd());
  let config = null;
  if (repo) {
    try {
      config = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'agentmash', 'config.json'), 'utf8'));
    } catch {
      /* not connected, or not readable -- flags and env can still carry it */
    }
  }
  const server = (args.server || process.env.AGENTMASH_URL || config?.url || '').replace(/\/+$/, '');
  const room = args.room || process.env.AGENTMASH_ROOM || config?.room || '';
  return { repo, server, room, label: config?.label ?? null };
}

async function main(argv, findRoom) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage(Boolean(findRoom));
    return;
  }
  const args = parseArgs(argv);

  const target = args.to ?? 'text';
  if (!TARGETS.includes(target)) {
    die(`--to must be one of ${TARGETS.join(', ')} (got "${target}")`, EXIT_USAGE);
  }

  const webhook = args.webhook || process.env.AGENTMASH_DIGEST_WEBHOOK || '';
  const chatId = args['chat-id'] || process.env.AGENTMASH_DIGEST_CHAT_ID || '';
  const posting = (target === 'slack' || target === 'telegram') && !args['dry-run'];
  if (posting && !webhook) {
    die(`--to ${target} needs --webhook (or AGENTMASH_DIGEST_WEBHOOK), or --dry-run`, EXIT_USAGE);
  }
  if (posting && target === 'telegram' && !chatId) {
    die('--to telegram needs --chat-id (or AGENTMASH_DIGEST_CHAT_ID)', EXIT_USAGE);
  }

  const minutes = parseDuration(args.since ?? '7d', '--since');
  const timeoutMs = integer(args.timeout, 10_000, '--timeout');
  const thresholds = {
    hotMinDevs: integer(args['hot-min-devs'], DEFAULTS.hotMinDevs, '--hot-min-devs'),
    hotMinEdits: integer(args['hot-min-edits'], DEFAULTS.hotMinEdits, '--hot-min-edits'),
    hotWindowHours: args['hot-window'] ? parseDuration(args['hot-window'], '--hot-window') / 60 : DEFAULTS.hotWindowHours,
    pairMinFiles: integer(args['pair-min-files'], DEFAULTS.pairMinFiles, '--pair-min-files'),
    stallDays: integer(args['stall-days'], DEFAULTS.stallDays, '--stall-days'),
  };

  // Every usage mistake is said before the room is looked for, which for
  // npx agentmash digest can be a request to the server.
  let { repo, server, room, label } = resolveRoom(args);
  // The machine's sign-in, from npx agentmash digest: beside a room key, to
  // the key's own server, for a room that asks for one; or with the room's
  // ref, for a repository connected on the website and nothing committed.
  let user = null;
  if (findRoom) {
    const found = await findRoom({ repo, server, room });
    if (found.problem) die(found.problem, found.code ?? EXIT_USAGE);
    ({ server, room } = found);
    user = found.user ?? null;
    label = label ?? found.label ?? null;
  }
  if (!server || !room) {
    die(
      'no room to read -- run this inside a repo wired up with `agentmash init`, ' +
        'or pass --server and --room',
      EXIT_USAGE
    );
  }

  // AGENTMASH_DIGEST_NOW pins the clock (ISO or epoch ms). It exists so a
  // fixture dated to a fixed week keeps landing inside "--since 7d" no matter
  // when the suite runs; nothing in production sets it.
  const pinned = process.env.AGENTMASH_DIGEST_NOW;
  const pinnedMs = pinned ? (/^\d+$/.test(pinned) ? Number(pinned) : Date.parse(pinned)) : NaN;
  const now = Number.isFinite(pinnedMs) ? pinnedMs : Date.now();
  const periodEnd = now;
  const periodStart = now - minutes * 60_000;

  // Two periods in one read: this one, and the one before it to compare against.
  const { events, truncated } = await fetchEvents(server, room, minutes * 2, { timeoutMs, user });

  const model = aggregate(events, {
    room,
    label: label ?? (await fetchLabel(server, room, timeoutMs, user)),
    now,
    periodStart,
    periodEnd,
    previousStart: periodStart - minutes * 60_000,
    truncated,
    ...thresholds,
  });

  const opts = {
    includeHints: Boolean(args['include-hints']),
    includeLink: Boolean(args.link),
    link: args.link ? await fetchDashboardLink(server, room, timeoutMs, user) : null,
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && target === 'text',
  };
  const output = render(model, target, opts);

  if (!posting) {
    process.stdout.write(typeof output === 'string' ? output : `${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  if (target === 'slack') await postSlack(webhook, output, timeoutMs);
  else await postTelegram(webhook, chatId, output, timeoutMs);

  const where = target === 'slack' ? 'Slack' : 'Telegram';
  const what = model.quiet ? 'quiet-period digest' : `digest (${model.totals.edits} edits, ${model.hot_zones.length} hot zones)`;
  process.stderr.write(`${prefix()}: posted the ${what} to ${where}\n`);
}

/**
 * Runs the digest for `argv` (the words after the command), setting
 * process.exitCode and never exiting. `name` is what it is called in its
 * help and its messages. `findRoom({ repo, server, room })`, from the CLI,
 * gives the room to read: { server, room, user, label }, `user` the machine's
 * sign-in to send beside it, or { problem, code } when there is none.
 */
export function runDigest(argv, { name = 'agentmash-digest', findRoom = null } = {}) {
  NAME = name;
  return main(argv, findRoom).catch((err) => {
    if (err instanceof Exit) return; // die() already reported and set the code
    if (err instanceof DigestError) report(err.message, EXIT_FAILURE, err.hint);
    else report(err?.stack || String(err), EXIT_FAILURE);
  });
}
