# The public API

`npx agentmash login` connects the coding agents it knows, and there is always one it does
not: the one your team built itself, a bot, a CI job, an editor plugin. This page is for that
one. There are two ways in, and they reach the same room.

- **Your tool has hooks** (a command it runs before and after a tool call, with JSON on
  stdin): register the generic hook, `agent_hook.mjs`, and it answers in the format your tool
  reads. It reports the edits, asks before one and words the advice exactly as the Claude Code
  hooks do. See [your own tool's hooks](#your-own-tools-hooks-the-generic-hook) below.
- **Your tool talks HTTP**: call `/api/v1`, described here, with a room key or a personal API
  token. The machine-readable version is `GET /api/v1/openapi.json` (OpenAPI 3.1).

The wire contract under both is [PROTOCOL.md](../PROTOCOL.md). `/api/v1` is protocol 1 under
a versioned path, plus what a client of its own needs: a bearer token, the advice an agent
should be shown, a stream it can read without a WebSocket, and errors in one shape.

## Base URL and versioning

`https://agentmash.dev/api/v1`, or `/api/v1` on [your own server](https://agentmash.dev/docs/self-host). Every route of protocol 1 is
there under the same name (`POST /api/v1/events` is `POST /events`, answered by the same code),
and the unversioned routes stay where they are, unchanged, for the hooks already committed to
repositories: they are never removed.

Within v1, changes are additive only: new optional fields, query parameters, endpoints, frame
types and error codes. Ignore a field, a frame type or a code you do not know, and fall back on
the HTTP status. A change that would break a client goes to `/api/v2`, which runs beside v1 for
at least twelve months; a v1 route on its way out sends `Deprecation` and `Sunset` headers at
least six months before it goes, and this page says so.

## Authentication

Send one credential, as `Authorization: Bearer <token>`. The older headers work too, and mean
the same:

| Token | What it is | Opens | The same as |
| --- | --- | --- | --- |
| `mash_…` | the room key, from `.claude/agentmash/config.json` | its own room | `x-agentmash-room: mash_…` |
| `amu_…` | a machine's sign-in, from `npx agentmash login` | every connected repository its login can push to | `x-agentmash-user: amu_…` |
| `amp_…` | a personal API token, from [agentmash.dev/keys](https://agentmash.dev/keys) or `npx agentmash token create` | the same, held to its scopes and repositories | (v1 only) |

- A room key names its own room. With an `amu_` or `amp_` token, name the room by its ref:
  `x-agentmash-room: rm_…`, or `?room=rm_…`, which is safe because a ref is not a secret. `GET
  /api/v1/lookup?repo=owner/name` gives the ref for a repository. A room-scoped route with no
  room named answers 400 `room_required`.
- A developer token (`amt_…`, from a room whose `token_mode` is on) still goes in
  `x-agentmash-token` beside the key; sent as a Bearer it answers 400 `invalid_credentials`.
  Two credentials that disagree answer 400 `ambiguous_credentials`; anything else as a Bearer
  answers 401 `invalid_token`, with a `WWW-Authenticate` header.
- A room key in a repository that is public on GitHub, whose room is connected to it, is
  anyone's who reads it, so it opens the room only beside the sign-in of someone who can push
  there: send `x-agentmash-user: amu_…` with it. Alone, or beside anyone else's sign-in, it
  answers 403 `room_key_public`, with the repository as `repo`.
- A room that asks for a sign-in (one `npx agentmash init` made, or one whose admin ran `npx
  agentmash secure sign-in`) opens to its key the same way, public repository or not: only beside
  the sign-in of someone who can push to the repository it is connected to, or who was invited to
  it. Alone, or beside anyone else's sign-in, the key answers 403 `sign_in_required`, with that
  repository as `repo` (none while it is connected to none). `GET /api/v1/room` says which it
  is as `sign_in_required`.
- A room key in a query string (`?room=mash_…`) answers 400 `key_in_url` everywhere but
  `/api/v1/live` and `/api/v1/stream`, because a browser cannot set a header on a WebSocket or
  an `EventSource`. Anywhere else it would land in every access log between you and us.
- `/api/v1` reads no cookie, so a page open in someone's browser cannot call it as them.

**Which one to use.** A room key is a shared secret with no expiry, for one room: right for CI
and bots. A personal token is a person's, for their own tools: it opens what its login can push
to, and like every sign-in it goes quiet when that person has not signed in for 30 days
(`AGENTMASH_PUSH_ACCESS_DAYS`), answering 401 `reauth` until they run `npx agentmash login` or
sign in on the website again. A room connected to a repository that is public on GitHub, and a
room that asks for a sign-in, have no credential that lasts: their keys open them only beside
such a sign-in (`room_key_public` and `sign_in_required`, above), which goes quiet the same way,
so CI there has to sign in again at least once a month.

### Personal API tokens

The quickest way is [agentmash.dev/keys](https://agentmash.dev/keys): sign in with GitHub, make a
key, copy it, and the page shows the first calls to paste, with your room's ref in them. A
signed-in machine makes them too; nothing else can, a room key and another token included (403
`machine_token_required`).

```bash
npx agentmash token create --name ci-bot --read-only --repo acme/app --expires 30d
npx agentmash token list
npx agentmash token revoke ci-bot
```

`create` prints the token alone on stdout, so `TOKEN=$(npx agentmash token create --name ci)`
keeps it, and says the rest on stderr. The token is shown that once and kept only as a hash.

- **Scopes:** read and write by default; `--read-only` gives a token that answers 403
  `insufficient_scope` to anything but a GET.
- **Repositories:** every one its login can push to by default; `--repo owner/name`, once or
  more, limits it, and a room of another repository answers 403 `token_repo_forbidden`.
- **Expiry:** 90 days by default, 1 to 365 (`--expires 30d`), or `--expires never`, only when
  asked for by name.
- **Limits:** 25 live tokens a person, 10 made an hour.
- **Where they work:** `/api/v1` only. An `amp_` token on an unversioned route answers 401
  `api_token_v1_only`, so its scopes, repositories and rate limits are checked in one place.
- Revoking one ends its open live views and streams at once.

Over HTTP, with the machine's sign-in as the Bearer: `POST /api/v1/tokens` with `{ "name",
"scopes", "repos", "expires_in_days" }`, `GET /api/v1/tokens` and `DELETE
/api/v1/tokens/{id}`.

## Endpoints

| Method and path | What it does |
| --- | --- |
| `POST /api/v1/events` | Report an edit, a prompt or the end of a session (protocol 1's body) |
| `GET /api/v1/events` | The room's events, newest first, a page at a time (`next_cursor`) |
| `GET /api/v1/check?file_path=…` | Ask before editing a file: who else is in it, and the advice to show the agent |
| `GET /api/v1/claims` | Live claims, or those on the given paths or symbols |
| `POST /api/v1/claims` | Claim files for a task, for a bounded time; nothing is locked |
| `POST /api/v1/claims/release` | Release one claim, or every claim of a session |
| `GET /api/v1/collisions?advisory=1` | Files the caller changed that a teammate changed too |
| `POST /api/v1/resolutions` | Say how a collision was settled |
| `GET /api/v1/activity` | The room right now: sessions, presence, claims, hot files, recent events |
| `GET /api/v1/team` | Teammates at work now, and what each is on |
| `GET /api/v1/live` | The room's frames, live, over a WebSocket |
| `GET /api/v1/stream` | The same frames as server-sent events |
| `GET /api/v1/lookup?repo=owner/name` | Which room a repository reports to, for a sign-in or a token |
| `GET /api/v1/room` | The room, for any credential that opens it |
| `GET /api/v1/me` | Who this credential is |
| `POST /api/v1/tokens`, `GET /api/v1/tokens`, `DELETE /api/v1/tokens/{id}` | Personal API tokens |
| `/api/v1/lobby/invites`, `/api/v1/lobby/members`, `/api/v1/lobby/presence`, `/api/v1/lobby/profile` | Teammates: invites by GitHub login, who is online and what each is doing, profiles ([below](#teammates-invites-who-is-online-profiles-the-lobby)) |
| `/api/v1/lobby/inbox` | Teammate requests: ask a teammate's agent for something, and answer what you were asked ([below](#teammate-requests-the-inbox)) |
| `GET /api/v1/lobby/context` | The room in a few lines, for an agent to read: who is at work on what, claims, files more than one person changed ([below](#the-room-for-an-agent-the-context-block)) |
| `GET /api/v1/openapi.json` | This API as an OpenAPI 3.1 document, open to anyone |

Room creation, the admin routes (rotation, settings, purge, deletion) and the sign-in flows are
not in v1: they stay on the routes the CLI calls, in [the README's API
section](../README.md#api).

The lobby app's own routes are left out here: its heartbeat, `GET /api/v1/lobby` and its
stream, the hive, the keys requests are signed with, the requests waiting on you in every room,
and approving, delivering and reporting on a request. They are the app's contract with the
server; `openapi.json` lists them.

### Asking before an edit

`GET /api/v1/check` is `/check` with one more field, `advice`: the exact text an agent should
read before it edits the file, worded by the same code the hooks use, so your tool says what
Claude Code is told, and says it differently only when the hooks do.

```bash
curl -s "https://agentmash.dev/api/v1/check?file_path=src/models/user.ts&developer=bob&branch=main" \
  -H "Authorization: Bearer $AGENTMASH_ROOM"
```

```json
{
  "conflict": true,
  "holders": [{ "developer": "alice", "file_path": "src/models/user.ts", "minutes_ago": 2, "branch": "main", "task_hint": "add soft deletes", "change_summary": "+12/-3 lines, touching deletedAt" }],
  "claimed": false,
  "claims": [],
  "advice": {
    "level": "active",
    "severity": 4,
    "developer": "alice",
    "file": "src/models/user.ts",
    "text": "[AgentMash: ACTIVE COLLISION] alice's agent is working in src/models/user.ts — last write 2 min ago on main, as you are, while working on 'add soft deletes' (+12/-3 lines, touching deletedAt). …",
    "parts": [{ "level": "active", "developer": "alice", "text": "…" }],
    "strict_block": true
  }
}
```

Show `advice.text` as it is. `level` says how loud it is, from `nearby` to `active`, and
`claimed` for a claim alone; `severity` is the same as a number, -1 to 4. `strict_block` is
whether a client in strict mode stops the edit: a claim alone never does. `advice` is null when
there is nothing to say, and null with `advice_unavailable: true` on the rare answer the server
could not word. `branch` and `checkout_id` make the wording right for a teammate on another
branch, or in another clone of yours; `hints=0` leaves teammates' task descriptions out.
`self=session&session_id=<the session your events carry>` leaves out only that session's own
edits and claims, so the same developer's other sessions come back marked `yours: true` and
worded as "your other agent", which strict mode never stops for. Add
`lobby_session=<the desktop app's session>` when asking from one, and claims held as
`lobby:<that session>` are left out as the asker's own too.

### Reporting an edit

`POST /api/v1/events` takes protocol 1's event, one per file, with the path relative to the
repository root and `tool` naming your client:

```json
{
  "developer": "bob@example.com",
  "session_id": "your-tool-session-42",
  "event_type": "edit",
  "tool": "mytool:Edit",
  "file_path": "src/models/user.ts",
  "git_branch": "main",
  "task_hint": "add a role to users",
  "change_summary": "+2/-1 lines, touching role"
}
```

What each field means is [PROTOCOL.md](../PROTOCOL.md#4-the-event), and what a client must do when the server is slow
or down is [§6](../PROTOCOL.md#6-what-a-client-must-do-on-failure): a hard timeout, no retries,
and on any failure, nothing at all.

### Live: a WebSocket, or server-sent events

`GET /api/v1/live` upgrades to a WebSocket (a plain GET answers 426 `upgrade_required`); `GET /api/v1/stream` sends the same frames as
`text/event-stream`, for a client that would rather read lines. Each frame is a JSON object
with a `type`: `hello`, `event` (with the changed text when the room streams diffs), `claim`,
`claim_released`, `claims_released` and `resolution`; ignore a type you do not know.

On the stream, each frame is `event: <type>` and `data: <the same JSON>`, with `id:` on event
frames. It opens with `retry: 5000`, sends a `: keepalive` comment every 25 seconds, and ends
with an `event: close` frame carrying the code: 4001 when the credential no longer opens the
room (stop reconnecting), 4003 when the room was deleted, 1001 when the server is restarting.
A credential holds five streams at once and a server a thousand; past that, 429
`stream_limit`. A room holds 200 WebSockets at once and an address 100; past that, the socket
closes with 1013 (try again later). A WebSocket that stops reading is closed once a mebibyte of
frames waits for it. There is no replay from `Last-Event-ID` yet: a client that reconnects reads
`GET /api/v1/events` for what it missed.

### A session shared live (the lobby)

The lobby app shares one of its person's sessions live with teammates in the room: its
conversation, its terminal and its files, as they change. The server only relays: the apps
encrypt every frame end to end, under a key the host makes and seals to each participant's
device key, and the server never reads past a frame's first byte. What is inside the frames is
the app's own; this is the wire.

| Method and path | What it does |
| --- | --- |
| `PUT /api/v1/lobby/device-key` | This machine's device key: `{ "machine_id": "mc_…", "public_key": "<base64url of 32 bytes>", "signing_key": "<base64url of 32 bytes>" }`, the public half of an X25519 key pair, and of the ed25519 key the machine signs the requests it sends with (optional; one left out keeps the one on file). 204 |
| `GET /api/v1/lobby/device-keys?login=a&login=b` | The device keys of those logins that can open the room: `{ "keys": [{ "login", "machine_id", "public_key", "signing_key", "updated_at" }] }`, `signing_key` null for a machine that put none. A login that can't is left out |
| `GET /api/v1/lobby/share?session=ls_…&invite=room` | Share a session, over a WebSocket: the host. `invite` is `room`, or logins, comma-separated, 50 at most |
| `GET /api/v1/lobby/share/{share_id}` | Join a share, over a WebSocket |

All four take a machine's sign-in alone (`amu_`, with the room's ref), as the lobby app's daemon
sends it: a room key answers 403 `person_required`, a personal token 403
`machine_token_required`. A sign-in is one machine's: it joins a share as the machine it put
its device key for, and answers 409 `device_key_required` until it has put one; signing it out
(`npx agentmash logout`) takes its key away. A host shares a live session of its own machine's,
or is told 404 `session_not_found`; a participant not on the invite list is told 403
`not_invited`. Refusals come before the upgrade, as HTTP with the error shape below; a plain GET
answers 426 `upgrade_required`. `updated_at` moves only when a machine's key changes: pin each
key the first time you see it, and say so before using one that changed.

On the socket, the first frame is text, `hello`: `share_id`, `you` (your slot: 0 for the host,
participants from 1), `host` (0) and `participants`, everyone else on it (`slot`, `login`,
`machine_id`). Then `joined` (`slot`, `login`, `machine_id`) and `left` (`slot`) as people come
and go. Everything else is binary: send the slot a frame goes to as its first byte (255 for
everyone but you) and your bytes after it; it arrives with the slot it came from as its first
byte, the rest as you sent it. A frame to a slot nobody is in goes nowhere. A text frame from you
closes your socket 1003.

| Limit | |
| --- | --- |
| A frame | 256 KiB, its first byte among them; one more closes it 1009 |
| A share | 16 sockets, the host's among them |
| A sign-in | 5 shares and share sockets at once; a server, 1000 share sockets. Past either, 429 `share_limit` |
| A socket's pace | about 200 frames and 2 MiB in 10 s; past that it is read from more slowly, and nothing is dropped |
| A socket behind | 1 MiB waiting to be sent to it, and it is closed 4008 |

Each socket is pinged every 25 s. The host stops sharing by closing its socket with 1000: the
share ends at once, and its id takes nothing back. A host whose socket ends any other way
(dropped, a ping it didn't answer, another code) has 30 s to connect again from the same
machine with `&share_id=<id>` (an old socket of its own still open there is closed 4009), or
the share ends. It ends at once, too, when its session ends, and when its host starts a new
share of the same session. Its participants are closed 4010 then, and the room is told. 4001
means the credential no longer opens the room (a host's ends its share), 4003 that the room was
deleted, 1001 that the server is restarting: a share lives in the server's memory alone, so a
restart ends every share, and the app starts it again.

The room is told that a share is open, never what is in it: a client that sends
`x-agentmash-lobby-features` with `share` gets `share: { "id", "invite", "since" }` (or null) on
each session in `GET /api/v1/lobby`, and a `session_upsert` on the lobby stream when a share
starts or ends. Nothing of a share is written anywhere: no table, no log line, no audit row.

## Teammates: invites, who is online, profiles (the lobby)

What the lobby app's member list runs on: adding a teammate by their GitHub login, who in a room
is online and what each is doing, a teammate's last week, and the name and picture each person
chose. A machine's sign-in (`amu_`) for every write that lets someone in or out, and for presence;
a personal token (`amp_`) only reads, and sets its own profile unless it is held to repositories
(403 `token_repo_forbidden`: a profile is the person's in every room).

| Method and path | Credential | What it does |
| --- | --- | --- |
| `POST /api/v1/lobby/invites` | machine, room ref | `{ "login": "damir" }`: invite a GitHub login. 201 `{ "invite" }`, or 200 with the one already waiting, or 200 `{ "invite": null, "member" }` when they are a member by invite already and you vouch for them from now |
| `GET /api/v1/lobby/invites` | person, no room | `{ "you", "invites": [Invite] }`: the invites waiting for you |
| `POST /api/v1/lobby/invites/{id}/accept` | machine, no room | the person invited joins: `{ "invite", "room": { "room_ref", "repo", "label", "dashboard_url" } }` |
| `POST /api/v1/lobby/invites/{id}/decline` | machine, no room | the person invited says no: `{ "invite" }` |
| `POST /api/v1/lobby/invites/{id}/cancel` | machine, no room | its sender takes it back: `{ "invite" }` |
| `DELETE /api/v1/lobby/members/{login}` | machine, room ref | leave a room you joined by invite, or remove someone who did (you can push there). 204 |
| `POST /api/v1/lobby/presence` | machine, no room | `{ "machine_id": "mc_…", "online": true }`: this app is open (or closing, `false`) |
| `GET /api/v1/lobby/members` | person, room ref | everyone the room opens to: online or not, and their sessions at work |
| `GET /api/v1/lobby/members/{login}/activity` | person, room ref | a teammate's last 7 days in every room you are both in |
| `GET /api/v1/lobby/plan` | person, room ref | the plan the room bills to, its seats here and its notices, for the app's settings; the subscription's status and the account's seats only to whoever may read its plan; an upgrade link only on a free plan where plans are counted |
| `GET /api/v1/lobby/profile`, `PUT /api/v1/lobby/profile` | person, no room | your display name: `{ "display_name": "Damir I." }`, or `null` for your login |
| `PUT /api/v1/lobby/profile/avatar`, `DELETE /api/v1/lobby/profile/avatar` | person, no room | your picture: the image itself as the body |
| `GET /api/v1/lobby/avatars/{login}/{hash}` | none | a picture, by the link `avatar_url` gives |

An `Invite` is `{ "id": "inv_…", "room_ref", "repo", "label", "login", "avatar_url",
"invited_by", "invited_by_display_name", "invited_by_avatar_url", "state", "created_at",
"expires_at", "answered_at", "seats_full", "checkout_url" }`; `state` is `pending`, `accepted`,
`declined`, `cancelled` or `expired`. `checkout_url`, while `seats_full`, is the way to the checkout
of the account the room bills to, on this server (`/go/checkout?from=app&account=…`), for an
upgrade button beside the invite; `null` otherwise.

**Who may invite.** Someone GitHub says can push to the room's repository, as fresh as a member's
sign-in (30 days). Owning the room is not enough: an owner who connected it can push there anyway,
and one who claimed it with its key could be anyone who read the key. A member by invite never
invites anyone (403 `cannot_invite`), and neither does a room key, alone or not. The room must be
connected to a repository (409 `room_not_connected`). The login is held to GitHub's rules, 39
characters at most of letters, digits and single hyphens (400 `invalid_login`); it is never yours
(400 `self_invite`) nor someone in the room through GitHub already (409 `already_member`). An
invite already waiting for that login is answered as it is, 200. Someone who is a member by invite
already is vouched for by you from now, 200 `{ "invite": null, "member": { "login", "invited_by",
"joined_at" } }` (see below). 20 invites a person an hour and 50 waiting a room, past which 429
`invite_limit`. While the server is closed (`AGENTMASH_CLOSED`), anyone it lets in invites
whoever they like but someone taken off its allowlist (403 `closed`): the invitee signs in, on
the website or from the lobby app (`POST /auth/cli/start` with `"client": "lobby"`), to list and
answer their invites and nothing else, and accepting one lets them in too. A terminal's
sign-in (`npx agentmash login`) is still refused them until then.
Nothing is emailed: the person invited sees it in the lobby app (`GET /api/v1/lobby/invites`;
`invites_waiting` in every presence answer says when to ask) and on the website at
[agentmash.dev/invites](https://agentmash.dev/invites), which a room's people and access pages link to,
and where signing in on the website lands while one waits.

**Answering.** Only the person invited accepts or declines (403 `not_invitee` to its sender, 404
`not_found` to anyone else, whatever the id); only its sender cancels (403 `not_inviter`). An
invite waits 14 days, then expires. One answered, cancelled or expired is 409 `invite_closed`,
with its `state`; so is one whose sender can no longer push there (`reason: "inviter_cannot"`).
Accepting opens the room to that sign-in as it opens to someone who can push to its repository: the
lobby, the inbox, live shares, the dashboard, `GET /api/v1/me`'s `connected`, `/api/v1/lookup`,
and the hooks, which report under the login. It never administers the room. With plans enforced, a
plan with no seat left says so in the same words as a heartbeat's 402 `seat_limit`: to whoever
invites, when they invite, and to whoever accepts, when they accept, while the invite keeps waiting
(`seats_full: true` until a seat frees up), the 402 with `checkout_url` beside its `upgrade_url`. A
refusal is counted for the room's notice (`plan_notices`, below), so whoever pays hears of it. Each step is a row of the room's audit trail:
`invite_sent`, `invite_accepted`, `invite_declined`, `invite_cancelled`, `member_vouched`,
`member_removed` and `member_left`, naming the people and nothing else.

**Who vouches.** A membership by invite never outlives the access that let it in: the room opens to
a member by invite while whoever vouches for them (`invited_by`: who invited them, or the last
person who invited them again) can push to its repository. When GitHub stops saying so, or said so
more than 30 days ago because they haven't signed in since, the room closes to the member too, until
someone who can push there invites them again: that sets `invited_by` to them, with no new invite
to answer (and, with plans enforced, asks the plan for a seat first). The members list shows such a
member with `vouched: false`.

**Leaving and removing.** `DELETE /api/v1/lobby/members/{your login}` leaves a room you joined by
invite; someone who can push to its repository removes a member by invite the same way, one whose
voucher no longer can among them (403 `cannot_remove` for anyone else, an owner by its key among
them). Someone in it through GitHub is 409 `not_member_by_invite`: GitHub decides that. The room
stops opening to them at once, and their live views close 4001.

**Who is online.** The lobby app says it is open every 20 s with `POST /api/v1/lobby/presence`
(`interval_seconds` in its answer), on the timer its heartbeats keep, whether or not an agent
runs, and once with `online: false` as it closes. A heartbeat counts too. Its person is online in
every room they are in while one of their apps said so within 90 s (`ttl_seconds`, the
heartbeat's own window: three calls can go missing). Only the machine's random id and the time
are kept, one of each a sign-in (a machine id it sent before is forgotten), a week at most; signing
the machine out takes them. It is the person's, not a room's: every room they are a member of
tells it, by GitHub, ownership or invite, whether or not that machine ever linked the room, hosted
a session or worked a branch there; what they do (`sessions`) stays each room's own. A member by
invite the room no longer opens to (`vouched: false`) is never told online.

`GET /api/v1/lobby/members` answers `{ "room_ref", "repo", "label", "now", "you",
"online_window_seconds", "members", "invited", "you_can_invite", "plan_notices" }`; `you_can_invite`
says whether you invite, vouch and remove here (you can push there). `plan_notices` is what the
room's plan has to say, each `{ "id", "kind", "account", "plan", "period_end", "message", "refused",
"seats", "action" }`: `seats_full`, to everyone here, when its plan turned developers away for a seat
this period (`refused`: how many, never who, and whose seats were full, the account's or the room's
own for names sent with only its key); `over_seats`, only to someone who may read the account's plan,
when a paid team has more developers this period than it pays for (`seats`: paid, used, over).
`action` is its button, `{ "label", "url" }` on this server, or `null`. `id` stays the same for the
period, so one put away stays away until the period turns. The dashboard's `/activity` carries the
same `seats_full` notices as `plan_notices`. Each member is `{ "login", "display_name",
"avatar_url", "is_you", "joined", "invited_by", "joined_at", "vouched", "online", "last_online_at",
"status", "sessions" }`: `joined` is `github`, `owner` or `invite`; `vouched` is a member by
invite's, `true` while `invited_by` can push there and `false`, offline and with no sessions, once
they can't (the room is closed to them until someone invites them again), and `null` for everyone
else; `status`
is `working` (an agent of theirs at work here), `online` (an app open), `idle` (their sessions here
went quiet) or `offline`, the list in that order, 200 at most. `sessions` are theirs at work in this
room as the lobby shows them: `id`, `kind`, `agent`, `model`, `status`, `presence`, `intent`,
`branch`, `files` (the 5 they edited last), `started_at`, `updated_at`, `accepts_inbox`,
`attention` and `activity`. `invited` is the room's invites waiting. Ask again every 30 s while the
list is on screen.

**A teammate's week.** `GET /api/v1/lobby/members/{login}/activity?days=7&limit=100&before=…&before_id=…`
is `{ "login", "display_name", "avatar_url", "since", "rooms", "items", "next_before",
"next_before_id" }`, `items` newest first, then by id, from every room you are both in and never one
only one of you is. The next page is `before=` its `next_before` and `before_id=` its
`next_before_id`, both, so lines of one millisecond (an `/events` batch) are never missed; both are
`null` on the last page. Each item is `{ "id",
"at", "kind", "room_ref", "repo", "summary", "session_id", "agent", "branch", "file_path",
"files", "commit", "state", "peer" }`, `kind` one of `session_started`, `session_ended`, `edit`,
`commit`, `branch` (its `state`: `open`, `merged`, `landed` or `gone`), `claim`, `claim_released`
and `request`. It is made from what each room keeps already, for as long as it keeps it. A request
says who asked whom and how far it got, never its words, and only to its two people unless the hive
made it; a prompt only as the room's feed quotes it, its first line. 404 `not_found` for someone
not in this room.

**Profiles.** `GET` and `PUT /api/v1/lobby/profile` answer `{ "login", "display_name",
"display_name_set", "avatar_url", "avatar", "updated_at" }`, `avatar` being `uploaded` or `github`.
A display name is trimmed, then 1 to 40 characters on one line, with no control characters and none
a person can't see, blank fillers like U+3164 and U+2800 among them (400 `invalid_display_name`);
`null` goes back to your login. It never reads as the GitHub login of someone in a room with you, or
invited to one, fullwidth, any case, or with spaces, dots and underscores taken out (400
`invalid_display_name`: "a display name can’t be a GitHub login other than yours"); one chosen
before that person shared a room with you is shown there as your login instead. It is not unique and
never an identity: a lobby shows `@login` beside it wherever someone acts on it, the hive's author,
a request's sender and every approval prompt. A picture is the image itself as the body of `PUT
/api/v1/lobby/profile/avatar`, with `content-type` `image/png`, `image/jpeg`, `image/webp` or
`application/octet-stream`, 256 KiB at most (413). Its first bytes decide what it is, whatever the
request says: anything but PNG, JPEG or WebP, an SVG among them, is 415 `unsupported_image`, and so
is one cut short or not laid out as its type is. It is kept without its metadata: EXIF, XMP,
comments, PNG text chunks and anything after the image's end are taken out (where a photo was
taken, when, the device), and the hash is of what is kept. It is served at `avatar_url`,
`/api/v1/lobby/avatars/{login}/{hash}`, as the image its bytes are, with an
`ETag` (`If-None-Match` gets 304), `X-Content-Type-Options: nosniff` and `Content-Security-Policy:
default-src 'none'; sandbox`; the hash changes with the picture, and an old one answers 404.
Without one, `avatar_url` is GitHub's picture of the login.

Wherever the server names someone, it gives the name and picture they chose: `display_name` and
`avatar_url` beside each developer of `GET /api/v1/team` and `GET /api/v1/activity`, and, to a
lobby client that sends `x-agentmash-lobby-features` with `profiles`, `owner_display_name` and
`owner_avatar_url` on each session, `display_name` and `avatar_url` on each developer of `GET
/api/v1/lobby`, and `author_display_name` and `author_avatar_url` on each hive message. Another
name of someone's (a git email their signed-in machine reported under) is shown as them; any other
name that is no login (a git email sent with a room key alone) as itself, with no picture.

## Teammate requests (the inbox)

What `npx agentmash ask` and `npx agentmash inbox` run on, and the MCP server's `check_inbox`
and `reply_to_teammate`: one person in a room asks a teammate's agent for something, and
nothing runs until that teammate says yes. A request is stored as `pending`, signed by the
server (`server_sig`) and told to both people. Only someone who can push to the room's
repository, or who joined it by an invite that holds, sends one or is sent one.

Sending, accepting, saying no and taking back take a machine's sign-in (`amu_`, with the room's
ref): a personal token reads, and never sends or answers (403 `machine_token_required`), and a
room key is nobody's inbox (403 `person_required`).

| Method and path | What it does |
| --- | --- |
| `POST /api/v1/lobby/inbox` | `{ "to": { "user": "dana" }, "body": "check why ci is red on main" }`: send dana a request. 201 `{ "message", "delivery", "delivery_note" }`: `delivery` says how and when dana sees it, by whether their lobby app is open (`via`: `app_open`, `app_closed` or `cli_only`), with a sentence for you (`text`); `delivery_note` is that sentence again, as the lobby app reads it |
| `GET /api/v1/lobby/inbox` | Your requests in this room: to you (`box=in`), from you (`out`) or both (`all`, the default), newest first, 50 a page (`limit`, 100 at most); `state` takes states, comma-separated. `{ "messages", "next_before" }`: the next page is `before=` its `next_before`, until that is null |
| `GET /api/v1/lobby/inbox/{id}` | One request, with its trail (`history`). Only its two people see it: anyone else is told 404 `not_found` |
| `POST /api/v1/lobby/inbox/{id}/accept` | The person it is to takes it by hand: approved as a suggestion and done at once, and the answer carries its text for them to paste into their own agent. Nothing is delivered into any session |
| `POST /api/v1/lobby/inbox/{id}/deny` | The person it is to says no, with `{ "reason" }` (300 characters at most) or none |
| `POST /api/v1/lobby/inbox/{id}/cancel` | Its sender takes it back while it waits: it fails, with the code `canceled` |

Each answers `{ "message" }` but the list. A message is `{ "id": "msg_…", "room", "from_user",
"to": { "user", "session_id" }, "body", "body_sha256", "mode", "scope", "created_at",
"expires_at", "parent_msg", "hop", "server_sig", "sender_sig", "repo", "state", "state_changed_at", "approved",
"denied", "delivered_at", "result", "failure", "history", "hive_message_id" }`; `state` is
`pending`, `held_for_approval`, `approved`, `denied`, `expired`, `delivered`, `running`, `done` or
`failed`. `sender_sig` is the sending machine's own ed25519 signature, as its app sent it with the request
(`POST /api/v1/lobby/inbox` takes it as `sender_sig`), kept only when that machine's `signing_key` is on file,
and null otherwise. The server never checks it; the recipient's app checks it against that key.

**Sending.** `mode` is `suggest` (the default) or `queue`, and `scope` is `read_only` (the
default), `edit` or `edit+exec`: what the request asks for, which approving it can only narrow.
`ttl_minutes` is how long it waits, 1 to 1440, 60 by default. `to.session_id` names a live
session of theirs that takes teammate requests (404 `session_not_found` otherwise).
`parent_msg` makes it a reply to a request you sent or were sent here (404 `parent_not_found`
otherwise), and a chain of replies ends after three (400 `hop_limit`). The body is 32,000
characters at most, with none a person can't see: zero-width, bidi and tag characters are
refused (400 `body_hidden_chars`), since what the person approves has to be what their agent
reads. Not to yourself (400 `self_send`), nor to someone who can't push to the room's repository
(404 `recipient_not_member`). The same text to the same person within 10 minutes is 409
`duplicate`, with the first one's `message_id`. A sender sends 10 a minute (429
`rate_limited`), and a person has 50 open in a room at most (429 `inbox_full`).

**Answering.** Accepting and saying no are the recipient's (403 `not_recipient`), taking back is
the sender's (403 `not_sender`), and a request that has moved on, or expired, is 409
`invalid_transition`, with its `state`.

## The room for an agent (the context block)

`GET /api/v1/lobby/context` is what the hooks put in front of an agent in a room that has the
block on, when its session starts and at a prompt when the room has news: who is at work on what,
live claims, files more than one person changed, and, for a person, the requests waiting for
them. It answers `{ "room_ref", "version", "generated_at", "for", "text", "truncated", "counts",
"enabled" }`. Show `text` as it is: an `<agentmash-lobby …>` block, or `""` when there is nothing
to say. Teammates' words in it are sanitized, and it is information, never instructions.
`enabled` says whether the room has it on: `lobby_context` in its settings is `on`, or `auto`
(the default) once the lobby app has reported to the room. Off, `text` is `""`.

A sign-in is asked as its login; a room key opens it too, and `developer` says who is asking.
`branch` puts teammates on that branch first, and `files` (paths, comma-separated) the people who
changed what the asking session changed; `hook_session_id`, the agent's own session id, leaves
that session out of the block. `max_chars` is its length at most, 200 to 8000, 2000 by default.

## Errors

Every error on `/api/v1` has one shape, and every answer an `x-request-id` header:

```json
{ "error": "a sentence for a person", "code": "room_required", "request_id": "6f0c…" }
```

`code` is stable and snake_case; some errors carry more fields (a claim's `outcome`, a fork's
`fork`). Quote `request_id` when you write to us: it is the one thing in our log that finds
your request, which names a route and never its address, a header or a body.

| Status | Codes |
| --- | --- |
| 400 | `room_required`, `key_in_url`, `ambiguous_credentials`, `invalid_credentials`, `file_path_not_relative`, `invalid_request`, `invalid_login`, `self_invite`, `invalid_display_name`, `self_send`, `hop_limit`, `body_hidden_chars` |
| 401 | `room_unauthorized`, `reauth`, `signed_out`, `invalid_token`, `token_required`, `api_token_v1_only`, `unauthorized` |
| 402 | `seat_limit`, from a server that enforces plans: the plan has no seat left (`upgrade_url` says where to upgrade) |
| 403 | `insufficient_scope`, `token_repo_forbidden`, `machine_token_required`, `person_required`, `not_invited`, `cannot_invite`, `cannot_remove`, `not_invitee`, `not_inviter`, `not_recipient`, `not_sender`, `token_unverified`, `closed`, `room_key_required`, `room_key_public`, `sign_in_required`, `cross_site`, `forbidden` |
| 404 | `not_connected`, `not_found`, `session_not_found`, `recipient_not_member`, `parent_not_found` |
| 409 | `token_limit`, `device_key_required`, `room_not_connected`, `already_member`, `invite_closed`, `not_member_by_invite`, `duplicate`, `invalid_transition` |
| 410 | `room_deleted` |
| 413, 415 | the body is too large; send JSON (`json_only`), or a picture that is PNG, JPEG or WebP (`unsupported_image`) |
| 426 | `upgrade_required`: that address is a WebSocket |
| 429 | `rate_limited`, `stream_limit`, `share_limit`, `invite_limit`, `inbox_full`, with `Retry-After` |

## Rate limits

Counted per credential on `/api/v1`, in a fixed one-minute window: 1200 calls a minute to
`/api/v1/check`, 600 to every other read and 600 writes, which is room for a fifty-file commit
reported at once. Each answer carries `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset`, and a 429 a `Retry-After`. The unversioned routes the hooks call keep a
count of their own, far looser and with none of those headers: 6000 writes and 6000 calls to
`/check` a minute per credential, past which they answer 429 `rate_limited` with a
`Retry-After`.

## CORS

Any origin may call `/api/v1` (`Access-Control-Allow-Origin: *`), which is safe because it
reads no cookie: a page gets in only with a token it holds. The allowed headers are
`content-type`, `authorization`, `x-agentmash-room`, `x-agentmash-token`, `x-agentmash-user`
and `idempotency-key`; the exposed ones `x-request-id`, `retry-after`, `ratelimit-limit`,
`ratelimit-remaining`, `ratelimit-reset` and `idempotent-replayed`; a preflight is cached for
600 seconds. An `Idempotency-Key` is allowed through but not acted on yet: a write sent twice
is recorded twice, as protocol 1 says.

## Your own tool's hooks: the generic hook

A tool that runs a command before and after its tool calls needs no client of its own:
`npx agentmash login` puts `agent_hook.mjs` in `~/.agentmash/hooks`, and that one script is
what every connector since the first four runs. It reads what your tool sends, asks the room or
reports to it through the same scripts Claude Code runs, and answers in your tool's format.
The advice, strict mode, claims, symbols and identity are those scripts', so they never drift.

`npx agentmash hook --print-command` prints the line to register, one per event:

```bash
npx agentmash hook --print-command --client mytool --event pre_edit --dialect json
# node "/home/you/.agentmash/hooks/agent_hook.mjs" pre_edit --global --client mytool --dialect json
```

Register that `node` line, never `npx`: npx looks the package up on every call, which takes
seconds when it is cold, and the hook before an edit has 1.5 seconds to answer. The line is the
same string every time for the same arguments, with no version in it, so an agent that asks
the person to approve a hook (Codex does) asks once.

| Event | When your tool runs it | What it does |
| --- | --- | --- |
| `pre_edit` | before a tool that changes files | asks the room, and answers with the advice, if any |
| `post_edit` | after one | reports each file, in the background, and answers at once |
| `prompt` | when the person sends a prompt | reports it, and answers with a heads-up when a teammate is near |
| `session_start` | when a session starts | answers with that heads-up |
| `stop` | when the agent finishes a turn | answers with a word for the person when a teammate changed the same files |
| `session_end` | when the session ends | reports it |

`--client` names your tool, a short lowercase name: the room shows its edits as
`mytool:Edit` and `mytool:Write`. `--global` finds the room for the checkout by this machine's
sign-in, as every connector's hooks do. To try a configuration by hand, `npx agentmash hook
pre_edit --client mytool --dialect json < payload.json` runs the same hook once.

### What it reads

With `--input native`, a dialect reads your tool's own JSON (the connectors' dialects each read
one agent's). Otherwise, send this, and it is read whatever your tool is:

```json
{
  "agentmash": 1,
  "session_id": "your-tool-session-42",
  "cwd": "/home/you/src/app",
  "files": [{ "path": "src/models/user.ts", "before": "id: string", "after": "id: string; role: string" }],
  "tool": "replace_in_file"
}
```

- `session_id` is your tool's own stable id for the session, at most 200 characters; `cwd` is
  where it works, and the repository is found from there.
- `files`, for `pre_edit` and `post_edit`, are the files the call changes, absolute or relative
  to `cwd`. `before` and `after` are the text replaced and its replacement; `after` alone is a
  whole new file; `edits: [{ "before", "after" }]` is several edits of one file. A plain string
  is a path alone. A file outside the repository is dropped before anything is sent.
- `patch`, in place of `files`, is an `apply_patch`-format patch; `command`, after a shell
  command, has the working tree say what it changed.
- `prompt` is what the person typed, for `prompt`. `agent_id` and `agent_type` name a
  subagent; `end_reason` goes with `session_end`, and `stop_hook_active` with `stop`.

Who the developer is never comes from stdin: it is the GitHub login the machine signed in
with, else their git email, as for every hook.

### What it answers

`--dialect` picks the answer's format. Left out, it is the dialect named like the client when
there is one, else `claude`.

| Dialect | For | Before an edit |
| --- | --- | --- |
| `claude` | tools that read Claude Code's hook output | `hookSpecificOutput.additionalContext`, the advice beside the edit |
| `deny-once` | tools whose hook before a tool can only let it run or refuse it, with a reason the model reads | the first try refused, with the advice as the reason; the same edit again goes through |
| `plain` | tools that put a hook's stdout in front of the model | the advice as text |
| `json` | anything else, and your own code | the result, below |

```json
{ "agentmash": 1, "event": "pre_edit", "action": "advise", "level": "active", "text": "[AgentMash: …] …", "files": ["/home/you/src/app/src/models/user.ts"], "strict": false }
```

`action` is `allow`, `advise` or `deny`, and `deny` only in a room's strict mode. A dialect is
one file in `~/.agentmash/hooks/dialects/`, `export default { name, parse, answer, neutral,
tools }`; the ones the connectors use are there too, and the comment at the top of
`hooks/agent_hook.mjs` is the whole contract.

### It fails open

Anything going wrong (an event or dialect it does not know, no `--client`, stdin that is not
JSON, a room that is down or slow, `AGENTMASH_DISABLE=1`) is the dialect's neutral answer and
exit 0, in time: the call goes on as it would have without the hook. Nothing it says ever
approves something the person would otherwise be asked about.
