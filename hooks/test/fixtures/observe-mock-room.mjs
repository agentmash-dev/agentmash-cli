// A stand-in for a room's /observations in the sync tests
// (observe-sync.test.mjs, observe-worker.test.mjs): a server on a port of its
// own that holds what a room holds of observations and writes down every
// request it was sent. No database and no checks but the few a test leans on;
// the real ones are the server's (server/src/observations.ts).
//
//   room.sharing, room.share_since   the room's switch, and when it was turned on (ms)
//   room.entries                     what it accepted, by report id (o:add:<id>,
//                                    o:seen:<id>:<ts>, o:forget:<id>, o:refute:<id>:<ts>:<developer>,
//                                    o:told:<id>:<ts>:<developer>, o:use:<id>:<ts>:<developer>,
//                                    o:stale:<id>:<ts>:<developer>): { developer, entry, seq }
//   room.requests                    every request, in order: { at, method, path, query,
//                                    room, token, user, body, raw, bytes }
//   room.posts()                     the POST /observations among them
//   room.answer                      what GET /observations answers, when a test says;
//                                    otherwise the findings made from what was accepted
//   room.fail                        what every POST answers instead, when a test says:
//                                    a status, or { status, json }
//   room.refuse                      (entry) => a code, for an entry the room will not keep
//   room.missing                     true for a server from before /observations: 404
//
// Findings are merged by title, as far as a test needs it: the same title
// from two developers is one finding with `people` 2. A `refute` is taken of a
// finding the room was sent and of no other (`no_finding`), and a finding says
// how many developers refuted it since it was last made or seen (`refuted`). A
// `told` and a `use` are taken the same way, and counted an entry each since
// then (`told`, `used`; a `use` is a telling too, so `used` is never the larger).
// A `seen` from a developer who has no telling of the finding makes them one
// more of its `people`, with no words of their own, as the server's does.
// A `stale` is taken as a `refute` is, and only with the commit it was cast
// at (`head`, 7 to 64 hex characters; `shape` without): a finding says how
// many developers voted it stale since it was last made or seen (`stale`),
// apart from who refuted it. And a finding is given with the blob ids its
// first telling carried (`blobs`), by which a reader holds it to a checkout.

import http from 'node:http';

const OBSERVATION_ID = /^o_[a-z0-9]{8,40}$/;
const COMMIT_ID = /^[0-9a-f]{7,64}$/i;
const titleKey = (title) => String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const reportId = (entry, developer) => {
  if (entry.op === 'add') return `o:add:${entry.obs?.id}`;
  if (entry.op === 'seen') return `o:seen:${entry.id}:${entry.ts}`;
  if (entry.op === 'refute' || entry.op === 'told' || entry.op === 'use' || entry.op === 'stale') return `o:${entry.op}:${entry.id}:${entry.ts}:${developer}`;
  return `o:forget:${entry.id}`;
};

/** The room's findings from what it accepted, the one heard last first. */
function findingsOf(room) {
  const byTitle = new Map();
  const bySource = new Map();
  for (const { developer, entry, seq } of [...room.entries.values()].sort((a, b) => a.seq - b.seq)) {
    if (entry.op === 'add') {
      const obs = entry.obs;
      const key = titleKey(obs.title);
      let finding = byTitle.get(key);
      if (!finding) {
        finding = {
          id: obs.id,
          type: obs.type,
          title: obs.title,
          facts: obs.facts,
          files: obs.files,
          symbols: obs.symbols,
          evidence: obs.evidence,
          branch: obs.branch,
          head: obs.head,
          blobs: obs.blobs ?? {},
          developer,
          agent: obs.agent,
          first_ts: obs.ts,
          last_ts: obs.ts,
          seen: 0,
          commit: null,
          sources: new Map(),
          refuters: new Set(),
          voters: new Set(),
          told: 0,
          used: 0,
          heard: seq,
        };
        byTitle.set(key, finding);
      }
      finding.sources.set(obs.id, developer);
      finding.seen += 1;
      finding.last_ts = Math.max(finding.last_ts, obs.ts);
      finding.heard = seq;
      finding.refuters.clear();
      finding.voters.clear();
      Object.assign(finding, { told: 0, used: 0 });
      bySource.set(obs.id, finding);
    } else if (bySource.has(entry.id)) {
      const finding = bySource.get(entry.id);
      if (entry.op === 'seen') {
        if (![...finding.sources.values()].includes(developer)) finding.sources.set(`${finding.id}+${developer}`, developer);
        finding.seen += 1;
        finding.last_ts = Math.max(finding.last_ts, entry.ts);
        finding.heard = seq;
        finding.refuters.clear();
        finding.voters.clear();
        Object.assign(finding, { told: 0, used: 0 });
      } else if (entry.op === 'refute') finding.refuters.add(developer);
      else if (entry.op === 'stale') finding.voters.add(developer);
      else if (entry.op === 'told') finding.told += 1;
      else if (entry.op === 'use') Object.assign(finding, { used: finding.used + 1, told: Math.max(finding.told, finding.used + 1) });
      else finding.sources.delete(entry.id);
    }
  }
  return [...byTitle.values()]
    // a finding is told in somebody's words: with only people who named it left, it is gone
    .filter((finding) => [...finding.sources.keys()].some((source) => !source.includes('+')))
    .sort((a, b) => b.heard - a.heard)
    .map(({ sources, heard, refuters, voters, ...finding }) => ({ ...finding, people: new Set(sources.values()).size, refuted: refuters.size, stale: voters.size }));
}

/** Starts a room. Resolves it with `url`, `port` and `close()` beside what the top of this file lists. */
export function startRoom({ sharing = false, shareSince = 0 } = {}) {
  const room = {
    sharing,
    share_since: shareSince,
    entries: new Map(),
    seq: 0,
    requests: [],
    answer: null,
    fail: null,
    refuse: () => null,
    missing: false,
    posts: () => room.requests.filter((r) => r.method === 'POST' && r.path === '/observations'),
    findings: () => findingsOf(room),
  };

  const post = (body) => {
    if (room.fail) return typeof room.fail === 'number' ? [room.fail, { code: 'unavailable' }] : [room.fail.status, room.fail.json];
    if (!room.sharing) return [403, { code: 'sharing_off' }];
    if (!body || typeof body.developer !== 'string' || !body.developer || !Array.isArray(body.entries)) return [400, { code: 'invalid_request' }];
    if (body.entries.length > 50) return [400, { code: 'too_many_entries' }];
    let stored = 0;
    let known = 0;
    const refused = [];
    for (const entry of body.entries) {
      const id = entry?.op === 'add' ? entry.obs?.id : entry?.id;
      let code = room.refuse(entry);
      if (!code && (!['add', 'seen', 'forget', 'refute', 'told', 'use', 'stale'].includes(entry?.op) || !OBSERVATION_ID.test(String(id)))) code = 'shape';
      if (!code && entry.op === 'stale' && !(typeof entry.head === 'string' && COMMIT_ID.test(entry.head))) code = 'shape';
      if (!code && entry.op === 'add' && entry.obs.ts < room.share_since) code = 'before_sharing';
      if (!code && ['refute', 'told', 'use', 'stale'].includes(entry.op) && !room.entries.has(`o:add:${id}`)) code = 'no_finding';
      if (code) refused.push({ id: id ?? null, code });
      else if (room.entries.has(reportId(entry, body.developer))) known += 1;
      else {
        room.entries.set(reportId(entry, body.developer), { developer: body.developer, entry, seq: ++room.seq });
        stored += 1;
      }
    }
    return [200, { stored, known, refused, seq: room.seq }];
  };

  const get = (url) => {
    if (room.answer) return [200, room.answer];
    if (!room.sharing) return [200, { sharing: false, share_since: null, seq: room.seq, observations: [] }];
    const limit = Number(url.searchParams.get('limit')) || 500;
    return [200, { sharing: true, share_since: room.share_since, seq: room.seq, observations: findingsOf(room).slice(0, limit) }];
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://localhost');
      let body = null;
      try {
        body = raw.length ? JSON.parse(raw.toString('utf8')) : null;
      } catch {
        body = null;
      }
      room.requests.push({
        at: Date.now(),
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        room: req.headers['x-agentmash-room'],
        token: req.headers['x-agentmash-token'],
        user: req.headers['x-agentmash-user'],
        body,
        raw: raw.toString('utf8'),
        bytes: raw.length,
      });
      const send = ([status, json]) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      // a machine that reports through its sign-in asks which room its repository is connected to
      if (url.pathname === '/api/lookup') return send([200, { room_ref: 'rm_0123456789', developer: 'bob' }]);
      if (url.pathname !== '/observations' || room.missing) return send([404, { code: 'not_found' }]);
      return send(req.method === 'POST' ? post(body) : get(url));
    });
  });

  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      room.port = server.address().port;
      room.url = `http://127.0.0.1:${room.port}`;
      room.close = () =>
        new Promise((done) => {
          server.closeAllConnections?.();
          server.close(done);
        });
      resolve(room);
    })
  );
}
