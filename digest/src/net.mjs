// Everything that can hang. One timeout policy, one error type, no retries:
// a scheduler wants a clear non-zero exit far more than it wants a heroic client.

import net from 'node:net';

export class DigestError extends Error {
  constructor(message, { hint = null } = {}) {
    super(message);
    this.name = 'DigestError';
    this.hint = hint;
  }
}

const snippet = (s) => (s.length > 200 ? `${s.slice(0, 200)}...` : s).replace(/\s+/g, ' ').trim();

/**
 * Node races the addresses a hostname resolves to and gives each attempt 250 ms
 * by default. A TCP connect to a server a continent away takes longer than that,
 * so every attempt is abandoned, fetch rejects with ETIMEDOUT in ~300 ms, and the
 * caller sees a dead server that curl reaches fine. Give each attempt half the
 * request's own budget instead: a slow-but-working first address gets to finish,
 * and a blackholed one still leaves the other half for the next family.
 */
function widenConnectAttempts(timeoutMs) {
  try {
    net.setDefaultAutoSelectFamilyAttemptTimeout(Math.max(250, Math.floor(timeoutMs / 2)));
  } catch {
    // Node older than 18.18 has no such knob, and no such 250 ms default to undo
  }
}

async function request(url, init, timeoutMs, what) {
  let res;
  try {
    widenConnectAttempts(timeoutMs);
    res = await fetch(url, {
      ...init,
      // Short-lived process: don't leave keep-alive sockets holding exit open.
      headers: { connection: 'close', ...init.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new DigestError(
      timedOut
        ? `${what} timed out after ${timeoutMs}ms (${url})`
        : `${what} failed: ${err?.message || err} (${url})`,
      { hint: timedOut ? 'raise --timeout, or check the server is awake' : 'check the URL and network' }
    );
  }
  const text = await res.text();
  if (!res.ok) {
    throw new DigestError(`${what} returned HTTP ${res.status}: ${snippet(text) || '(empty body)'}`);
  }
  return { text, res };
}

/**
 * The room's credentials, as headers: the room (its key, or its ref) and the
 * machine's sign-in beside it when npx agentmash digest has one. Never in the
 * URL, where every access log between here and the server keeps a key.
 */
const credentials = (room, user) => ({ 'x-agentmash-room': room, ...(user ? { 'x-agentmash-user': user } : {}) });

/** A room's ref, which names a room and opens nothing: a sign-in beside it does. */
const isRef = (room) => /^rm_[0-9a-f]+$/.test(room);

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new DigestError(`${what} returned a response that is not JSON: ${snippet(text)}`);
  }
}

/**
 * Page backwards through the room's events. `/activity` stops at a few hundred
 * rows because the dashboard only ever shows a live slice; a week does not fit
 * in that, and a digest built from a silently truncated week is worse than none.
 */
export async function fetchEvents(server, room, minutes, { timeoutMs = 10_000, maxEvents = 20_000, user = null } = {}) {
  const events = [];
  let cursor = null;
  for (let page = 0; page < 200; page++) {
    const url =
      `${server}/events?minutes=${Math.ceil(minutes)}&limit=1000` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const { text } = await request(url, { method: 'GET', headers: credentials(room, user) }, timeoutMs, 'reading events');
    const body = parseJson(text, 'reading events');
    if (!Array.isArray(body?.events)) {
      throw new DigestError(
        `${server} answered /events without an events array — is it an AgentMash server?`
      );
    }
    events.push(...body.events);
    cursor = body.next_cursor;
    if (!cursor) return { events, truncated: false };
    if (events.length >= maxEvents) return { events, truncated: true };
  }
  return { events, truncated: true };
}

/**
 * The room's own label, when the local config didn't supply one: from
 * /rooms/self for a key, in a header, and /api/v1/room for a ref and the
 * sign-in beside it. Best effort: a digest without a title is still a
 * digest, so this never fails the run.
 */
export async function fetchLabel(server, room, timeoutMs, user = null) {
  try {
    const { text } = await request(
      `${server}${isRef(room) ? '/api/v1/room' : '/rooms/self'}`,
      { method: 'GET', headers: credentials(room, user) },
      timeoutMs,
      'reading the room'
    );
    return JSON.parse(text)?.label ?? null;
  } catch {
    return null;
  }
}

/**
 * Where --link points: the room's dashboard by its ref, which a browser
 * signed in with GitHub opens only for the room's people, so the channel is
 * handed no key. By the room id, the room's key, only where nothing else
 * opens it: a server too old to give rooms refs, or one that signs nobody in
 * (its /api/config says no oauth). Best effort, as the label is: a server
 * that does not answer gets the id, as every digest did before. A room read
 * by its ref, with a sign-in, is linked by that ref: there is no key to give.
 */
export async function fetchDashboardLink(server, room, timeoutMs, user = null) {
  const byKey = `${server}/r/${room}`;
  if (isRef(room)) return byKey;
  try {
    const [self, config] = await Promise.all([
      // the key in a header, never the URL (/rooms/self)
      request(`${server}/rooms/self`, { method: 'GET', headers: credentials(room, user) }, timeoutMs, 'reading the room'),
      request(`${server}/api/config`, { method: 'GET' }, timeoutMs, 'reading the server'),
    ]);
    const ref = JSON.parse(self.text)?.room_ref;
    const signsIn = JSON.parse(config.text)?.oauth === true;
    return signsIn && typeof ref === 'string' && /^rm_[0-9a-f]+$/.test(ref) ? `${server}/r/${ref}` : byKey;
  } catch {
    return byKey;
  }
}

export async function postSlack(webhook, payload, timeoutMs) {
  await request(
    webhook,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
    timeoutMs,
    'posting to Slack'
  );
}

/** Accepts the full sendMessage URL, a `bot<token>` fragment, or a bare bot token. */
export function telegramUrl(webhook) {
  if (/^https?:\/\//.test(webhook)) return webhook;
  const token = webhook.startsWith('bot') ? webhook.slice(3) : webhook;
  return `https://api.telegram.org/bot${token}/sendMessage`;
}

export async function postTelegram(webhook, chatId, messages, timeoutMs) {
  const url = telegramUrl(webhook);
  for (const text of messages) {
    const { text: body } = await request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      },
      timeoutMs,
      'posting to Telegram'
    );
    // Telegram answers 200 with ok:false for a bad chat id or bad markup.
    const parsed = parseJson(body, 'posting to Telegram');
    if (parsed?.ok === false) {
      throw new DigestError(`Telegram refused the message: ${parsed.description ?? snippet(body)}`);
    }
  }
}
