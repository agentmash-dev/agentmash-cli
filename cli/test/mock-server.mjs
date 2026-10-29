// Minimal stand-in for the coordination server, shared by the CLI tests.
import http from 'node:http';

export const ROOM = 'mash_climesticlimesticlim';
export const ROTATED_ROOM = 'mash_rotatedrotatedrotated';
/** A key this server once opened a room to, and no longer does: rotated past its grace, or revoked. */
export const ROTATED_AWAY = 'mash_rotatedawayrotatedaway';
/** A key this server never had. */
export const UNKNOWN_KEY = 'mash_unknownunknownunknown';

/**
 * `githubSignIn`, when given, is the answers /auth/cli/token gives in order to
 * a server with GitHub sign-in set up; without it, the server has none (503).
 * `alsoActive` is more developers /activity shows a session of, and `you`, when
 * given, what it says the asking developer's names are (a server that knows a
 * person's other names says so; an older one does not). `supportsSignIn` false
 * is a server from before a room could ask for a sign-in beside its key: it
 * says nothing of sign_in_required, and does nothing with it. `signsIn` is a
 * server with GitHub sign-in (/api/config says oauth), whose new rooms come
 * with their ref; without it, /api/config is not there, as on a server too old
 * to have one, and a new room has no ref. `repo`, when given, is the
 * repository /rooms/self says the room is connected to.
 */
export function startMockServer({
  roomExists = true,
  supportsRotation = true,
  supportsRoomSelf = true,
  githubSignIn = null,
  alsoActive = [],
  you = null,
  supportsSignIn = true,
  signsIn = false,
  repo = null,
} = {}) {
  const requests = [];
  // what POST /rooms/settings set, as /rooms/self then says it
  const settings = {};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null });
      const send = (code, payload) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      // a request that lands after close (a background report): nothing to answer it with
      if (!server.listening) return res.destroy();
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (url.pathname === '/healthz') return send(200, { ok: true });
      if (url.pathname === '/api/config' && signsIn) return send(200, { oauth: true, closed: false, server_url: origin });
      // a key the server turns away, as its requireAuth does on every route
      // but /rooms/self, which says which kind of key it is (describeRoom)
      const key = req.headers['x-agentmash-room'];
      if (key === ROTATED_AWAY || key === UNKNOWN_KEY) {
        if (url.pathname === '/rooms/self') {
          return key === ROTATED_AWAY
            ? send(404, { error: 'this room id has been rotated or revoked', rotated: true, code: 'room_rotated' })
            : send(404, { error: 'no such room', code: 'room_unknown' });
        }
        return send(401, { error: 'unknown, expired or missing room key — send x-agentmash-room', code: 'room_unauthorized' });
      }
      if (url.pathname === '/rooms' && req.method === 'POST') {
        return send(201, {
          room: ROOM,
          ...(signsIn ? { room_ref: 'rm_abc123' } : {}),
          label: body ? JSON.parse(body).label : null,
          server_url: origin,
          dashboard_url: signsIn ? `${origin}/r/rm_abc123` : `${origin}/r/${ROOM}`,
        });
      }
      if (url.pathname === '/rooms/rotate') {
        if (!supportsRotation) {
          // exactly what an older Fastify server answers for an unknown route
          return send(404, { statusCode: 404, error: 'Not Found', message: 'Route POST:/rooms/rotate not found' });
        }
        return send(200, {
          room: ROTATED_ROOM,
          room_ref: 'rm_abc123',
          previous_expires_at: new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString(),
          grace_minutes: 4320,
          dashboard_url: `${origin}/r/${ROTATED_ROOM}`,
        });
      }
      if (url.pathname === '/rooms/tokens' && req.method === 'POST') {
        return send(201, {
          token: 'amt_clitokenclitokenclitoken',
          developer: JSON.parse(body).developer,
          source: 'room-key',
          room_ref: 'rm_abc123',
        });
      }
      if (url.pathname === '/rooms/tokens/revoke' && req.method === 'POST') {
        // one live token, for a name someone enrolled; none for any other
        return send(200, { revoked: JSON.parse(body).developer === 'alice@example.com' ? 1 : 0 });
      }
      if (url.pathname === '/auth/cli/start') {
        if (githubSignIn) {
          return send(201, { code: 'WXYZ-2345', poll_token: 'poll', verify_url: `${origin}/auth/github?cli=WXYZ-2345`, expires_in: 600 });
        }
        return send(503, { error: 'GitHub sign-in is not configured on this server' });
      }
      if (url.pathname === '/auth/cli/token' && githubSignIn) {
        const answer = githubSignIn.shift() ?? { status: 202, body: { status: 'pending' } };
        return send(answer.status, answer.body);
      }
      if (url.pathname === '/rooms/settings' && req.method === 'POST') {
        const { sign_in_required, ...rest } = JSON.parse(body || '{}');
        Object.assign(settings, rest, supportsSignIn && sign_in_required !== undefined ? { sign_in_required } : {});
        return send(200, { ok: true, token_mode: 'off', ...(supportsSignIn ? { sign_in_required: false } : {}), ...settings });
      }
      if (url.pathname === '/rooms/disconnect' && req.method === 'POST') {
        return send(200, { repo: 'acme/app', room_ref: 'rm_abc123', ...(supportsSignIn ? { sign_in_required: settings.sign_in_required === true } : {}) });
      }
      if (url.pathname === '/rooms/tokens' && req.method === 'GET') {
        return send(200, { token_mode: 'off', ...(supportsSignIn ? { sign_in_required: false } : {}), ...settings, tokens: [] });
      }
      if (url.pathname === '/rooms/self') {
        // A server older than this route answers it from its /rooms/:id route,
        // which does not recognise "self" — a 404 carrying no `code`.
        if (!supportsRoomSelf) return send(404, { error: 'no such room' });
        return roomExists
          ? send(200, { label: 'team repo', room_ref: 'rm_abc123', token_mode: 'off', ...(repo ? { repo } : {}), ...settings })
          : send(404, { error: 'no such room', code: 'room_unknown' });
      }
      if (url.pathname.startsWith('/rooms/')) {
        return roomExists
          ? send(200, { room: ROOM, label: 'team repo', room_ref: 'rm_abc123', token_mode: 'off' })
          : send(404, { error: 'no such room' });
      }
      if (url.pathname === '/activity') {
        return send(200, {
          room: ROOM,
          sessions: [
            {
              developer: 'alice@example.com',
              session_id: 's1',
              task_hint: 'refactor the user model',
              git_branch: 'main',
              last_touched: new Date(Date.now() - 22 * 60_000).toISOString(),
              last_ts: Date.now() - 22 * 60_000,
              last_seen_ts: Date.now() - 22 * 60_000,
              presence: 'stale',
              presence_label: 'has sent nothing for 22 min and appears to have stopped',
              files: [{ file_path: 'src/models/user.ts', ts: Date.now() - 22 * 60_000, task_hint: 'refactor the user model' }],
            },
            {
              // edited the API for one prompt, and has since asked for another
              developer: 'bob@example.com',
              session_id: 's2',
              task_hint: 'fix the typo in the README',
              git_branch: 'main',
              last_touched: new Date(Date.now() - 60_000).toISOString(),
              last_ts: Date.now() - 60_000,
              last_seen_ts: Date.now() - 60_000,
              presence: 'active',
              presence_label: '',
              files: [
                {
                  file_path: 'src/api/users.ts',
                  ts: Date.now() - 90_000,
                  task_hint: 'add role and isAdmin to the user model',
                },
              ],
            },
            ...alsoActive.map((developer, i) => ({
              developer,
              session_id: `s-also-${i}`,
              task_hint: null,
              git_branch: 'main',
              last_touched: new Date(Date.now() - 5 * 60_000).toISOString(),
              last_ts: Date.now() - 5 * 60_000,
              last_seen_ts: Date.now() - 5 * 60_000,
              presence: 'active',
              presence_label: '',
              files: [],
            })),
          ],
          ...(you ? { you } : {}),
          hot_files: [
            {
              file_path: 'src/models/user.ts',
              developers: ['alice@example.com', 'bob@example.com'],
              count: 2,
              last_touched: new Date().toISOString(),
            },
          ],
          events: [],
        });
      }
      send(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      })
    );
  });
}
