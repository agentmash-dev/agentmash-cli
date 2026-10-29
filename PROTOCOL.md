# The AgentMash wire protocol

**Protocol 1.** This document is the contract between an AgentMash *client* and an
AgentMash *server*. It is written for someone who has never seen this repository:
if you follow it, whatever you build — an editor hook, a git hook, a CI job, a
daemon watching the filesystem — shows up in the room alongside everyone else.

The Claude Code hooks in [`hooks/`](hooks/) are one client. They are not the
protocol. Everything below describes what they already send, so an old copy of
them keeps working forever against a new server.

---

## 1. The model

A **room** is a shared stream of events about one repository. A **client** posts
events into it. Anything reading the room — the dashboard, `agentmash status`,
another client's advisory check — sees the union of every client's events.

An **event** is a single observation: *this developer touched this file, at this
time, on this branch, while doing this*. Events are facts about the past. The
server never asks a client anything and never calls back.

The value of the room is proportional to how much of the team it can see. A room
that sees half a team gives advice based on half the truth, which reads as
authoritative and is not. That is the entire reason this document exists.

---

## 2. Transport

HTTP/1.1, JSON bodies, UTF-8. `POST /events` is the write path; that endpoint is
protocol 1 and is frozen (see [§8](#8-versioning)).

```
POST /events HTTP/1.1
Host: agentmash.example
content-type: application/json
x-agentmash-room: mash_xf2Qb7kR9vN1pLd0

{"developer":"alice@example.com","session_id":"…","event_type":"edit", …}
```

**201 Created** `{"ok":true,"id":1234}` on success. To an `edit` from someone signed in (a sign-in beside
the key, or a member) the reference server adds `inbox_note`: the one line `GET /team` gives while
teammate requests wait for them, never a request's text, or `null` while none do; a client may
ignore it. Any other status means the
event was not recorded. At runtime a client does the same thing for all of them —
nothing, see [§6](#6-what-a-client-must-do-on-failure) — but they mean different
things to whoever is *writing* the client:

| Status | Means | What the author should do |
| --- | --- | --- |
| `201` | Stored. | — |
| `400` | The body does not match [§4](#4-the-event): a missing required field, a wrong type, a string over its maximum, or `{"code":"file_path_not_relative"}` for a `file_path` that is not in the repository ([§4.3](#43-file-paths)). This will fail forever, not just now. | Fix the client. Retrying cannot help. |
| `401` | `{"code":"room_unauthorized"}`: the room id is missing, malformed, or unknown to this server. `{"code":"token_required"}`: the room asks for a developer token ([§3](#3-identifying-a-room)) and none was sent. `{"code":"reauth"}`: the sign-in sent beside the key is too old for the server to say who can push, and opens nothing until the machine signs in again. Also what a server that requires authentication returns to a client that sends none ([§8](#8-versioning)). | Check the room resolution and the credentials in [§3](#3-identifying-a-room). At runtime: exit silently. |
| `402` | The room's plan has no seat for this `developer`: `{"error":"seat_limit","code":"seat_limit","message":"…","upgrade_url":"…"}`. Only from a server that enforces plans (the reference server with `AGENTMASH_BILLING=enforce`), only for a developer not counted in the period when the plan's seats are taken, and never for the git client's report of a commit (`tool` `"git-commit"`, `session_id` `commit-<sha>`, an `edit` or `session_end`, no `prompt_id`): a teammate seen only through commits is not a seat. Nothing of the event is stored. | Nothing at runtime, and no retry: every event is refused the same way until the team's plan changes. A client may show `message` to the developer, once; the Claude Code hooks say it at the next prompt. |
| `403` | `{"code":"room_key_public"}`: the room key is in a repository that is public on GitHub and connected to the room, so anyone could have read it there, and it opens the room only beside the sign-in (`x-agentmash-user`) of someone who can push to that repository. `{"code":"sign_in_required"}`: the room asks for that sign-in beside its key whatever the repository's visibility (`npx agentmash secure sign-in`, which `agentmash init` runs for a room it connects), and none came that can push there. `{"code":"token_unverified"}`: the room takes only developer tokens GitHub vouched for (`token_mode` `github`). | Send the machine's `npx agentmash login` token beside the key, as the reference hooks do, or the developer token the room asks for. At runtime: exit silently. |
| `404` | No such endpoint. A protocol-2 client talking to a protocol-1 server gets this. | Fall back to `POST /events` ([§8](#8-versioning)). |
| `410` | `{"code":"room_deleted"}`: the room was deleted, and only its audit trail is left. | Nothing at runtime; every event is refused the same way. |
| `413` | The body is over the server's limit — 1 MiB on the reference server. Only reachable by a client sending untruncated prompts or summaries. | Truncate to the maxima in [§4](#4-the-event). |
| `429`, `503`, `5xx` | Transient. The server is loaded, restarting, or broken. | Nothing. Do **not** retry ([§6](#6-what-a-client-must-do-on-failure) rule 4). |

**Limits.** The reference server counts writes (`POST /events` among them) and
`GET /check` per credential, 6000 of each a minute, a room key's count shared by everyone
holding it: far past what a team's hooks send, and a 429 past it. The body limit is 1 MiB.
Neither is a licence: one event per file touched, and a
client that would send hundreds should truncate and say so in `change_summary`
(the git client reports the first 50 files of a commit and states the real
count). `POST /rooms` is limited per IP as well.

CORS is open (`access-control-allow-origin: *`) with `content-type`, `authorization`,
`x-agentmash-room`, `x-agentmash-token`, `x-agentmash-user` and `idempotency-key` allowed, so
a browser-based client works too; `x-request-id`, `retry-after` and the `ratelimit-*` headers
are exposed to it, and a preflight is cached for 600 seconds.

The reference hooks and MCP server also send `x-agentmash-hooks` with their version (for
example `0.12.1`), so a server can tell which rooms still run old committed hooks. It is
information only: a client need not send it, and a server may ignore it.

Every route here is also under `/api/v1` (`POST /api/v1/events` is `POST /events`), with a
bearer token, one error shape and the advice an agent should read: that is the public API, for
a client of your own, in [docs/API.md](docs/API.md).

---

## 3. Identifying a room

Every request carries a room id, either as the `x-agentmash-room` request header
(preferred) or as a `?room=` query parameter. Both are accepted everywhere; the
header wins if both are present.

**Send the header.** The room id is a credential (below), and a credential in a
query string ends up in server logs, proxy logs and browser history. `?room=`
exists for the one place a header cannot be set — a browser `WebSocket` — and a
future server may restrict it to that. A client that sends the header is correct
under both.

```
mash_[A-Za-z0-9_-]{16,64}
```

**The room id is the credential, and in some rooms only half of it.** It is an
unguessable capability string: holding it is the authorization to read and write
that room, like a secret link, and in a room that asks for nothing more a
client's only job is to find the room id and send it. A room can ask for more,
and then turns the key alone away with the `401` and `403` answers in
[§2](#2-transport):

- **A sign-in beside the key**: `x-agentmash-user`, the token `npx agentmash login`
  keeps for the machine, of someone GitHub says can push to the room's repository.
  A room asks for one once `npx agentmash secure sign-in` was run on it, which
  `agentmash init` does for a room it connects to its repository, and so does any
  room whose key is in a public repository it is connected to. Sent beside the
  key, it also makes the `developer` that login ([§4](#4-the-event)).
- **A developer token**: `x-agentmash-token`, in a room whose `token_mode` is `any`
  or `github` (`npx agentmash secure`).
- **No key at all**: a signed-in developer names a room connected to their
  repository on the website by its ref (`rm_…`) in `x-agentmash-room`, beside their
  sign-in. A ref opens nothing on its own.

The reference hooks send whichever of these the machine has. A client that has
only the key keeps working in every room that asks for nothing more.

Where a client should look for it, in this order — this is the precedence the
Claude Code hooks implement and the one a new client should copy, because it is
what makes teammate setup a `git pull`:

1. `AGENTMASH_ROOM` / `AGENTMASH_URL` (and `AGENTMASH_ROOM_REF`) environment variables
2. `<repo>/.env`
3. `<repo>/.claude/agentmash/.env`
4. `<repo>/.claude/agentmash/config.json` — committed, travels with the repo:
   ```json
   { "url": "https://agentmash.example", "room": "mash_…", "label": "team repo", "room_ref": "rm_…" }
   ```
   `room_ref` is absent from a server too old to give rooms refs. `agentmash init`
   also writes `timeout_ms` when the server is far enough away to need a longer
   advisory budget, and a team may commit `strict`, `share_hints`,
   `stream_diffs` and `share_worktree` there; a developer's own environment
   variable wins over each.
5. None of those: a hook `npx agentmash login` installed for every repository on
   the machine asks the server which room the checkout's GitHub repository is
   connected to (`GET /api/lookup?repo=owner/name`, beside the machine's sign-in),
   and reports there by the room's ref. A checkout with an install of its own is
   left to that install.

`AGENTMASH_DISABLE=1` is the kill switch: a client that sees it **must** do
nothing and exit successfully. Honour it. It is the thing a teammate reaches for
when your client is misbehaving, and it has to work without them uninstalling
anything.

A client that cannot resolve both a URL and a room id **must** exit silently
without sending anything. An unconfigured repo is not an error.

---

## 4. The event

One JSON object. Three fields are required; the rest are optional and default to
`null`.

| Field | Type | Req | Max | Meaning |
| --- | --- | :-: | --- | --- |
| `developer` | string | **yes** | 200 | Who. Free-form identity: the reference hooks send `AGENTMASH_DEV` when it is set, else the GitHub login the machine is signed in as for this server (`npx agentmash login`), else `git config user.email`. Sent beside a sign-in (`x-agentmash-user`) of someone GitHub says can push to the room's repository, it is replaced by that login, lowercased, and the room remembers the name sent as another of that login's: one person, one developer, wherever their other machines report that name with the key alone. Remembered while signed-in machines keep sending it, within the room's retention; a name two logins sent is neither's, and one every machine of its kind shares (`root`, `vscode`, `unknown`) is nobody's. A request that says the name was set on purpose (`x-agentmash-developer-source: env`, which the reference hooks send whenever `AGENTMASH_DEV` is set) keeps it instead, so two terminals on one signed-in machine can be two developers: nothing is remembered, the seat is still the login's, and a name that is another login's, or another login's other name, is replaced by the login all the same. A signed-in developer's own request, the room's ref with no key (a repository connected on the website), is always that login: there the header changes nothing, and two terminals on one machine are one developer. Otherwise the server does not verify it **and does not normalize it**, beyond taking out what a person could not see, as from every field a teammate writes (`task_hint` below) — it is stored and grouped by exact bytes, so `Alice@Corp.com` and `alice@corp.com` are two people on the board, silently. Use the *same* string across every client on one machine. |
| `session_id` | string | **yes** | 200 | Which unit of work. Groups events into one row on the dashboard. Stable for the life of that unit; see [§4.1](#41-choosing-a-session_id). |
| `event_type` | string | **yes** | 50 | What kind of observation. See [§4.2](#42-event-types). |
| `tool` | string \| null | no | 100 | What did the touching, as the client sees it: `"Edit"`, `"Write"`, `"MultiEdit"`, `"NotebookEdit"` from Claude Code; `"Bash"` and `"PowerShell"` from Claude Code for files a shell command changed, which the hooks find in the working tree (`git status`) because a command names none; `"worktree"` from Claude Code for files no tool reported, found the same way: already uncommitted when a session started, or changed between prompts, by hand or by a command still running in the background. A `"worktree"` edit has no `task_hint` or `prompt_id`, since no prompt caused it. Its `timestamp` is when the hooks found it, not the file's own last write: work nobody has committed is work in progress however old it is, and an edit stamped hours back would never reach a teammate's `/check`. How old it really is goes in its `change_summary` instead (`"uncommitted before this session started, last written 3 hours ago"`). `"devin:write"`, `"devin:edit"` and `"devin:apply_patch"` from Devin, which runs the same hooks with no `--client`, through tools Claude Code has none of (hooks from before said them bare: `"write"`, `"edit"`, `"apply_patch"`); a patch's every file is reported as an `edit` of its own, under that one `tool`. The same hooks run by another agent, as `npx agentmash login` connects it, say which in front of the tool: `"codex:apply_patch"` and `"codex:Bash"` from Codex, `"copilot:create_file"`, `"copilot:edit"` and the like from GitHub Copilot, and the agent's name alone (`"codex"`) on a `prompt` or a `session_end`, where Claude Code sends no tool at all. `"git-commit"` from the git client, `"afterFileEdit"` from the Cursor adapter. **This is the field that carries client provenance** — it is how a reader tells an agent's edit from a human's commit. |
| `file_path` | string \| null | no | 1024 | The file touched, **repo-relative, forward slashes, no leading `./`**. Required in practice for `edit` events — an `edit` with no path is stored but can never match a conflict. A path that is not in the repository (absolute, `~/…`, or climbing out with `..`) is refused with a `400`. See [§4.3](#43-file-paths). |
| `git_branch` | string \| null | no | 200 | Branch name, no `refs/heads/` prefix. Detached HEAD: the short sha, except mid-rebase, where it is the branch being rebased. A name git would not allow, or one holding a character a person could not see, `<`, `>`, a look-alike of `<` (`＜`, `‹`, `〈` and the like) or `"`, is stored as null. |
| `task_hint` | string \| null | no | 500 | *Why*, in one line: the user's prompt, the commit subject, the ticket title. Turns "someone touched this file" into "someone is doing this to this file". Only words a person wrote: a turn the agent's harness sent on its own (a background task's notification, another session's message, a CI event, a loop or schedule wakeup) is never a hint, and the context a harness wraps around a typed prompt (Claude Code's `<system-reminder>` blocks and the like) is left out. Cleaned first, then whitespace-collapsed and truncated by the client. The server also drops the harness blocks a hint *starts* with, for clients older than that rule: a hint that was nothing else is stored as `null`, and the event is kept. On an `edit` it is **the prompt that edit was made under**, which is not always the session's newest: a subagent's edit carries the prompt that started the subagent, and an edit reported after the developer's next prompt still carries the one before. Readers pair a file with its own edit's hint, never with a later prompt. Other people's agents read it, so the server keeps it, and every other field a teammate writes (`developer`, `change_summary`, a claim's `task`), as the lobby quotes them: no character a person could not see (zero-width, bidi and tag characters, variation selectors), no control characters, no `<` or `>` and no look-alike of `<` (`＜`, `‹`, `〈` and the like), `"` made `'`, a hint's lines kept and each trimmed. A key pasted into it in a shape the server knows (`sk-…`, `ghp_…`, a private key, `DB_PASSWORD=…`; server/src/redact.ts has them all) is stored as `[hidden]`. |
| `prompt_id` | string \| null | no | 64 | Which prompt: on a `prompt`, an id the client made up for it; on an `edit`, the id of the prompt the edit was made under (the same prompt as its `task_hint`). Random, `[A-Za-z0-9_-]`, never derived from the prompt's text, so it goes with hints withheld too and says only which edits one prompt caused. Sanitised, never validated: an odd value costs the event the field, not a 400, and the server keeps it on `prompt` and `edit` events only. Old servers accept and discard it. |
| `checkout_id` | string \| null | no | 64 | Only on `edit`: which checkout (working tree) the edit was made in, as an opaque id, `[A-Za-z0-9_-]`. Two edits with the same id are in one working tree; two with different ids are not, even on branches of the same name (two clones of `main`). The reference clients make it as an HMAC, under a random key kept on the machine and never sent (`~/.agentmash/checkout-key`), of the hostname and the checkout's folder, so it names neither, and no guess at either can be checked against it. Sanitised, never validated: an odd value costs the event the field, not a 400. Readers get it back on each `/check` holder; absent or null means nobody can tell. Old servers accept and discard it. |
| `change_summary` | string \| null | no | 300 | *What*, compactly: `"+12/-3 lines, touching deletedAt"`, `"wrote 40 lines, defining parseConfig"`, `"commit a1b2c3d · +12/-3 lines"`. Free text, shown to a reading agent as the server keeps it: cleaned, and with keys masked, as `task_hint` is. |
| `symbols` | string[] \| null | no | 500 items | The exported declarations this edit changed, as plain names (`["createUser","Store"]`). Optional in both directions: a client that sends none gets path matching exactly as before, and a server that predates the field ignores it. The server filters and caps the contents, so a junk entry costs the event its symbols and never its `file_path`. Names only — no bodies, no signatures, no code. |
| `agent_type` | string \| null | no | 64 | Only on `edit`: which named subagent made the edit, when it is an agentmash crew agent: its catalog name without a plugin prefix (`"pipe-backend"`, never `"agentmash-crew:pipe-backend"`). Null for the main agent and for any agent outside the crew roster. A client must not send a name somebody gave their own agent; one that is spelled exactly like a crew name is indistinguishable from it and goes as that crew name, so what leaves is only ever one of the 22 public names. Sanitised, never validated, so it never costs an event a 400: the server stores it on `edit` events only (null on every other `event_type`), and keeps it only if it is one of the crew catalog's 22 names; anything else, another name, a non-string, any length, is stored as null and the event is accepted as usual. A server started without the crew catalog (`crew/` absent) cannot check the roster and keeps any string shaped like a catalog name (lowercase words joined by single hyphens, at most 64 characters). Old servers accept and discard it. |
| `end_reason` | string \| null | no | 50 | Only on `session_end`: how the session ended, as the client saw it (`"exit"`, `"clear"`, `"logout"`, `"other"`). A reader uses it to tell a session that finished from one that was cleared out from under it. |
| `timestamp` | string \| number \| null | no | — | When, as an ISO 8601 string or epoch **milliseconds**. Absent, null, or an unparseable string → the server's clock at receipt. A *number* is taken as milliseconds with no sanity check: send epoch seconds and the event is filed in 1970, accepted with a 201, and never appears in any reader's window. This is the single most likely mistake in a new client. A time later than the server's clock when the event arrived is stored as that arrival: nobody edited a file after the server heard about it, and a fast clock would otherwise keep someone looking busy long after they left. An earlier one is kept as sent. |

Extra fields are **accepted and discarded**. The request schema sets
`additionalProperties: true`, so sending an undocumented field will not be
rejected — but nothing stores it and nothing reads it. Do not invent fields and
assume they survive; if you need one, it has to be added here and to the store
first. (This is why there is no `source` field: `tool` already carries client
provenance, is already persisted, and is already visible to readers.)

### 4.1 Choosing a `session_id`

The reader groups events by `developer` + `session_id` into one "session". So the
id should name the unit of work a human would recognize:

- **A live agent session** — use the agent's own session id. Long-lived, many
  events, ends with a `session_end`.
- **A batch that is already over** by the time you can report it — a commit, a CI
  run — mint an id from the thing itself (`commit-a1b2c3d`) and, because the work
  is finished the moment you report it, follow the `edit` events with one
  `session_end`. Leaving a batch looking "active" for the next hour is a lie the
  dashboard will repeat.
- **Never** reuse one id for unrelated work, and never mint a fresh id per event —
  the first collapses a team into one row, the second explodes it into hundreds.

### 4.2 Event types

| `event_type` | Meaning | Who reads it |
| --- | --- | --- |
| `edit` | A file was modified. **The only type that participates in conflict detection** (`GET /check`) and hot-file aggregation. | advisories, dashboard |
| `prompt` | A human gave an instruction. Carries `task_hint` and, from newer clients, its `prompt_id`; no `file_path`. Sent for what a person typed, never for a turn the harness sent (Claude Code runs the same hook for both; the hook input's `source`, not an event field, and the harness's wrapper tags tell them apart), and such a turn does not replace the hint later events carry. | dashboard, session labelling |
| `session_end` | This session is over; stop showing it as active. | dashboard |

Unknown types are stored and ignored by every aggregation. Adding a type is
additive and safe; a client **must not** require the server to understand a type
it invented ([§8](#8-versioning)).

### 4.3 File paths

Conflicts match on **string equality of `file_path`** (plus, when the server is
configured with `AGENTMASH_SCOPE=dir`, on the parent directory). So the path is
the join key across an entire team, and normalizing it is the client's job:

- Make it relative to the root of the checkout the file is in: what `git status`
  there prints. A room is one repository, so another worktree of the same
  repository counts, and nothing else does.
- **Do not report a file outside the repository at all**: another repository
  open beside this one, a submodule, a scratch file, anything under `~`. Drop the
  event; do not send it to this room, and do not reroute it to another. The server
  refuses a `file_path` that is absolute (`/…`, `C:/…`, `//host/…`), starts with
  `~/`, or has a `..` segment with `400 {"code":"file_path_not_relative"}`,
  because a path like that means nothing to the rest of the room and names
  folders on the machine that sent it. A name that only starts with dots
  (`..env`) is a name, and is fine.
- Use `/` on every platform. The server also converts `\` → `/`, strips a
  leading `./` and drops empty and `.` segments, but do not rely on that —
  normalize before sending.
- Do not lowercase. The reference hooks spell a path the way the disk does:
  links and junctions followed, and on Windows each name in the case it was
  created with, so one file reached or typed two ways is still one string. Case
  differences across operating systems are **not** folded, which is a known
  limitation: a macOS client sending `src/User.ts` will not match a Linux client
  sending `src/user.ts`.

---

## 5. What the server promises

Short list, and it is short on purpose. Read it as the set of things you may
**not** assume.

**Ordering — none.** Events are stored with the timestamp the client supplied, or
with the time the server received them when the client's is later ([§4](#4-the-event)).
Readers sort by that timestamp (ties broken by insertion id), so a client whose
clock runs slow reorders itself relative to the team. Two events posted in order
may be stored out of order. Nothing depends on arrival order.

**Deduplication — none.** The server appends. Posting the same event twice
creates two rows. **Idempotency is the client's responsibility**, and it matters
for any client that can be re-run over the same work: a git hook that fires again
for a commit it has already reported must remember and skip it. (What duplicates
actually cost: an inflated event count and a file that looks hotter than it is.
They do not corrupt anything.)

**Delivery — at most once, unacknowledged in practice.** A 201 means it is
stored. Anything else, including a timeout, means *unknown*. The correct client
response to "unknown" is to forget it (see [§6](#6-what-a-client-must-do-on-failure)).

**Durability — append-only, then pruned.** Events older than a server-configured
retention window are deleted, counted from when the server received each one,
never from the timestamp a client sent. The reference server's default is 7 days,
a room's own setting or its plan may keep less, and a server may make it shorter
or longer. Do not assume a number. The room is a rolling window of recent
activity, not a history.

**Trust — what the room asks for.** The server believes `developer`, `timestamp`
and `task_hint` as sent, with only what a person could not see and keys it knows
taken out (`task_hint` above), a `timestamp` past its own clock pulled back to it,
and a `developer` sent beside the sign-in of someone who can push to the room's
repository replaced by that login ([§4](#4-the-event)). In a room that asks for
nothing beyond its key, anyone with the room id can write anything into it, under
any name. A room that asks for a sign-in or a developer token beside its key
([§3](#3-identifying-a-room)) takes writes only with one, and stores each under
the sign-in's login or the token's developer rather than the name it claims, but
for the `AGENTMASH_DEV` case §4 describes.

**Liveness of readers.** `GET /check` looks back `AGENTMASH_WINDOW_MIN` minutes
(default 30). `GET /activity` looks back `AGENTMASH_ACTIVITY_MIN` (default 60).
An event outside the window exists but is invisible to those readers, with one
exception: an `edit` on a branch that isn't the room's default branch is
remembered as work not merged yet, past any window, until that branch merges or
the memory horizon passes ([§14](#14-work-not-merged-yet--branch-memory)).

### Reading the room

| Endpoint | Purpose |
| --- | --- |
| `GET /check?file_path=…&developer=…` | "Has anyone *else* edited this file recently?" → `{conflict, holders[], window_minutes, scope}`. Each holder: `developer`, `task_hint`, `last_touched`, `minutes_ago`, `branch`, `file_path`, `change_summary`, `checkout_id` (the holder's edit's, or null: compared with the caller's own, it says whether their write is in the caller's working tree), `commit` when one has their write and all they changed in the file since (their own newest commit of it on that branch, or for work that landed by a squash, the default branch's commit it landed in: a caller with it in its history has their version in its tree; absent otherwise). A holder's `task_hint` is the prompt its own edit was made under; `null` when that edit had none, never a prompt another session was on. This is what a pre-edit advisory calls. With `&self=session&session_id=…` (the id the asking session's events carry, 1 to 200 characters), only that session's own edits and claims are left out, with the caller's commits and `worktree` edits, which no agent made: the caller's other sessions come back as holders and claims marked `yours: true`. `&lobby_session=…` beside them (the desktop app's session the asker runs in, 1 to 194 characters) leaves out the claims held as `lobby:<it>` too, the ones an agent's MCP server in that app session made. Any other `self`, or no usable `session_id`, is the answer without it. A `file_path` outside the repository gets `400 {"code":"file_path_not_relative"}`: nothing in the room can be on it. |
| `GET /activity?minutes=N` | Everything: sessions grouped by developer, hot files (2+ developers on one file), recent events. A session's `task_hint` and `prompt_id` are what it is on now: its newest prompt by `timestamp`, or its newest edit's while no prompt in the window has a hint or an id. With hints withheld that prompt is known by its `prompt_id` alone, and `task_hint` is `null`. Each of its `files[]` carries its own `task_hint` and `prompt_id`, from that file's newest edit: the prompt the file was edited for. |
| `GET /team?developer=…` | The other developers at work in the room, for an agent's context → `{developers[]}`. Each: `developer`, `presence`, `minutes_ago`, `branch`, `checkout_id` (the opaque id of the checkout their newest edit was made in, null when none said), `prompt` (their newest, as for `/activity`), `agent_type`, `files` (up to five paths, newest first) and `edits`: the same files as `{file_path, task_hint, ts}`, each with the prompt it was edited for. `files` stays a list of plain paths for clients older than `edits`. |
| `WS /live` | Push. Sends `{"type":"hello"}` on connect, then `{"type":"event","event":{…}}` per accepted write — with a sibling `diff` in a room that streams them ([§13](#13-streamed-diffs--presence-by-default-code-by-consent)). Read-only; nothing you send is interpreted. |
| `POST /rooms` `{label}` | Create a room → `{room, label, server_url, dashboard_url}`. Rate-limited per IP. |
| `GET /rooms/:id` | Does this room exist? |
| `GET /healthz` | Open, no room required. |

Every event a reader gets back — in `GET /activity`, `GET /events` and the
`WS /live` frames — carries `agent_type` as it was stored, and each `/activity`
session carries the `agent_type` of its newest `edit`: the crew agent at work in
that session right now, or null when the main agent made the last edit. Two crew
agents editing in parallel in one session (one `session_id`) share that one
value: the newest edit wins, so it follows whichever of them edited last. A
server older than the field sends neither; a reader treats absent as null.

None of them names the room by its id. A room's id is its first key, and a
reader may have come in without one (a member with a room ref and their own
token, an owner with a ref and a browser session), so `GET /activity` and
`GET /events` carry `room_ref`, the `WS /live` hello carries `room_ref`, and
events carry every column but `room_id`. The id goes back only to whoever
just made or rotated the key (`POST /rooms`, `POST /rooms/rotate`), and the
legacy `GET /rooms/:id` echoes the id its caller put in the path.

---

## 6. What a client must do on failure

This is the part that is not negotiable, and it is the reason AgentMash is safe to
install on a whole team's machines. **A client runs inside somebody's editor or
somebody's `git commit`. It is a guest there.**

1. **Never block the thing you are attached to.** Cap every network call with a
   hard timeout, sized per path rather than as one number. The Claude Code hooks
   use **1500 ms** for the one call that happens before an edit (it has to answer
   before the edit proceeds) and **2500 ms** for fire-and-forget reporting, which
   nobody waits on. Enforce them with an abort signal, not a prayer.

   Size the blocking one against what a *cold* client pays, not against a warm
   round trip: a fresh process pays TCP, TLS and the request before an answer can
   come back, so the real cost is about three round trips plus process start.
   our benchmark measured it — 160 ms on loopback, 454 ms
   at a 100 ms round trip, 1969 ms at 600 ms. A budget picked from a `curl`
   timing is roughly a third of what it needs to be, and the client that
   undershoots does not fail loudly: it delivers nothing, forever, silently.
2. **Exit 0. Always.** Server down, DNS broken, 500, garbage response, no config,
   malformed input, your own bug — all of it exits successfully. A non-zero exit
   from a hook is an error message in someone's terminal, and an error message
   about a coordination tool is worse than no coordination tool.
3. **Say nothing on the happy path.** No stdout, no stderr, no log line. The only
   permitted output is the host's own structured response format (a Claude Code
   hook JSON payload, say) when you actually have something to say to the agent.
4. **Never retry, never queue, never spool to disk.** A dropped event is a file
   that momentarily looks free. A retry queue is a background process on a
   developer's machine that outlives its usefulness and eventually surprises
   someone. Drop it and move on.
5. **Arm a self-destruct.** A stuck socket can outlive its timeout. Set an
   unref'd timer that calls `exit(0)` a few seconds out, so a wedged client
   cannot become a wedged editor.
6. **Do the work off the critical path where the host lets you.** Claude Code
   reporting hooks run with `async: true`; the git post-commit client backgrounds
   itself and returns immediately. Only an advisory that must speak *before* an
   action should ever be synchronous.
7. **Spend your budget on the `session_end` first, not last.** A client that
   reports a finished batch ([§4.1](#41-choosing-a-session_id)) and then runs out
   of time before closing the session leaves a room saying somebody is working
   who is not — a standing lie, where a dropped `edit` is a momentary gap. Reserve
   the budget for it, send it whatever happened to the rest, and post the batch
   with a little concurrency so it rarely comes to that.

A conforming client is one you can point at `http://127.0.0.1:1` and not notice.

---

## 7. A complete example

A human commits two files. The git client posts three events:

```jsonc
// 1
{ "developer": "alice@example.com", "session_id": "commit-a1b2c3d",
  "event_type": "edit", "tool": "git-commit",
  "file_path": "src/models/user.ts", "git_branch": "main",
  "task_hint": "Add soft deletes to the user model",
  "change_summary": "commit a1b2c3d · +42/-6 lines",
  "timestamp": "2026-08-30T11:04:07.000Z" }

// 2 — same session, second file
{ …, "file_path": "src/models/index.ts",
  "change_summary": "commit a1b2c3d · +2/-0 lines" }

// 3 — the batch is over the moment it is reported
{ "developer": "alice@example.com", "session_id": "commit-a1b2c3d",
  "event_type": "session_end", "tool": "git-commit",
  "git_branch": "main", "task_hint": "Add soft deletes to the user model",
  "timestamp": "2026-08-30T11:04:07.000Z" }
```

Four minutes later Bob's agent is about to edit the same file. Its advisory calls
`GET /check?file_path=src/models/user.ts&developer=bob@example.com` and gets:

```json
{ "conflict": true, "window_minutes": 30, "scope": "file",
  "holders": [ { "developer": "alice@example.com", "minutes_ago": 4,
                 "task_hint": "Add soft deletes to the user model",
                 "branch": "main", "file_path": "src/models/user.ts",
                 "change_summary": "commit a1b2c3d · +42/-6 lines" } ] }
```

Note what `change_summary` is doing there: it is the only thing telling Bob's
agent that this was a landed commit rather than an agent mid-edit. That is why
clients should put their provenance in it as well as in `tool`.

---

## 8. Versioning

The rule is **additive-only, forever, at a frozen path**.

- **`POST /events` is protocol 1 and will not change incompatibly.** Not the
  required fields, not the types, not the meaning of any documented field. A hook
  script vendored into a repo two years ago keeps working against a server
  deployed today. That property is the whole point: clients here are *copied into
  repositories*, not installed from a registry, so there is no upgrade path to
  rely on.
- **New optional fields may be added at any time.** A client that does not send
  one is not degraded — every optional field defaults to `null` and every reader
  handles `null`. A client may send fields a server does not know: they are
  accepted and discarded, never rejected.
- **New `event_type` values may be added at any time.** A server that does not
  recognize a type stores it and leaves it out of aggregations. A client **must
  not** depend on the server understanding a type it invented — invent one only
  when being ignored is an acceptable outcome.
- **Anything else is breaking**: removing a field, narrowing a type, repurposing a
  meaning, making an optional field required, changing what `edit` means for
  conflict detection. A breaking change is only allowed at a **new path**
  (`POST /api/v2/events`), never on `POST /events` or `POST /api/v1/events`.
- **Authentication is not a protocol change.** A server may require credentials —
  a token header, a signed request, mutual TLS — and answer `401` to a client that
  does not send them. That is not "making an optional field required": the event
  shape is untouched, and a client that gets a 401 does exactly what
  [§6](#6-what-a-client-must-do-on-failure) already tells it to do with any
  non-201, which is nothing, silently. A two-year-old vendored hook against a
  server that has since turned on authentication stops being *heard*; it does not
  break, and it starts working again the moment it is given a credential. Servers
  that do this should keep the room id working as the credential wherever they
  can, because that is what makes teammate setup a `git pull`.
- **A client for a future protocol must fall back.** There is no capability
  discovery (see the next point), so a protocol-2 client that gets `404` from
  `POST /api/v2/events` **must** retry once at `POST /events` and speak protocol 1,
  rather than exiting silently forever against every server deployed before it.
- **There is no version field on the wire, deliberately.** Version negotiation is
  one more round trip and one more thing a client can get wrong on the critical
  path of somebody's editor. **The endpoint path is the version.** A client that
  wants protocol 2 asks for protocol 2 by URL; a client that says nothing gets
  protocol 1 and is correct forever.
- **Compatibility is checked by test, not by intention.** `hooks/test/hooks.test.mjs`
  parses §4's field table and §4.2's type table *out of this document* and holds
  every event the hooks actually send to them: required fields present, no
  undocumented field sent, every string inside its maximum, timestamps in
  milliseconds, paths as §4.3 requires. Editing this document without editing the
  hooks — or the hooks without the document — fails that test.

---

## 9. Conformance checklist

A new client is conforming when all of these hold. Every one is testable against
a mock server in ~20 lines; see `hooks/test/hooks.test.mjs` and
`clients/test/git_hook.test.mjs` for the pattern.

- [ ] Resolves URL + room by the precedence in [§3](#3-identifying-a-room), and does nothing when either is missing.
- [ ] Honours `AGENTMASH_DISABLE=1`.
- [ ] Sends the room as `x-agentmash-room`.
- [ ] Sends `developer`, `session_id`, `event_type`; uses the same `developer` string as every other client on that machine.
- [ ] Sends repo-relative, forward-slash `file_path` on `edit` events, and sends nothing at all for a file outside the repository ([§4.3](#43-file-paths)).
- [ ] Sets `tool` to something that identifies the client.
- [ ] Is idempotent over its own re-runs ([§5](#5-what-the-server-promises)) — including over rewritten history, if your host has any: a `git commit --amend` is a new id for work already reported.
- [ ] Closes a finished batch with `session_end`, even when it ran out of budget partway through the batch ([§6](#6-what-a-client-must-do-on-failure) rule 7).
- [ ] Every network call has a hard timeout.
- [ ] Exits 0 and silently when the server is down, slow, or hostile — proven by a test against a closed port and a deliberately hung server.
- [ ] Never retries and never spools.
- [ ] Adds no dependencies to the host it runs in.

---

## 10. Known clients

| Client | Reports | Lives in |
| --- | --- | --- |
| Claude Code hooks | edits, prompts, session ends — live, before and after each tool call; the files a Bash or PowerShell command changed, and those already uncommitted when a session starts, from the working tree; which crew agent made an edit (`agent_type`), sent by the Claude Code hooks from the release after 0.4.0, and by repos installed through the web installer after this deploy | [`hooks/`](hooks/) |
| Git post-commit | files that landed in a commit, commit subject as the task hint | [`clients/git/`](clients/git/) |
| Cursor `afterFileEdit` | edits, live, after each agent write | [`clients/cursor/`](clients/cursor/) |
| The generic hook | whatever the agent running it sends: edits, prompts, session ends, through the Claude Code hooks' own scripts; every agent login connects beyond Claude Code, Codex, Cursor, GitHub Copilot and Devin runs it, in a dialect of its own | [`hooks/agent_hook.mjs`](hooks/agent_hook.mjs) |

What each of those can and cannot see — and what the other agent tools offer
today — is in [`docs/ADAPTERS.md`](docs/ADAPTERS.md).

---

## 11. Claims — stated intent

Everything above describes the past: *this developer touched this file*. A
**claim** describes the next hour: *this developer's agent is taking this scope
for this task*. It is the one thing a room can know **before** an edit, which is
the only moment a second agent can still choose different work.

Claims are optional. A client that never sends one is a conforming client.
`POST /events` is unchanged; claims live on their own endpoints, and an old
server without them answers 404, which a client treats like any other failure.

### 11.1 The model

- A claim names a `developer`, a `session_id`, a one-sentence `task`, one or
  more repo-relative `paths`, optional `symbols`, and a TTL.
- A path claims itself and everything beneath it: `src/auth` covers
  `src/auth/login.ts`. Two claims **overlap** when either path contains the
  other, or when they name a common symbol.
- A claim is **advisory**. It is not a lock and the server never enforces it;
  it is delivered as context to whichever agent asks or edits.
- A claim ends when released, when its TTL lapses (5–480 minutes, default
  120), or when the server receives a `session_end` event for its
  `session_id`. A crashed agent therefore cannot hold a scope for longer than
  its TTL.
- A claim made with `"until": "merged"` and the `branch` its work is on, a
  branch that isn't the room's default, is the branch's, not the session's: it
  stands through commits, pushes and new sessions, until the branch's work
  settles ([§14](#14-work-not-merged-yet--branch-memory)), until it is released
  by id or with `all`, or until the memory horizon (a week by default, never
  longer than the room keeps its history). `ttl_minutes` is ignored for it. On
  the default branch, or with no branch, it is an ordinary claim, and the
  answer says `"until": null`. A second such claim by the same person on the
  same branch renews the first: its paths and symbols joined, the new task, a
  new expiry, and `"renewed": true`. It is the renewing session's from then on,
  as its task is. Renewed from another session, the answer says whose claim it
  was: `"replaced": { "developer", "session_id", "task" }`, that session's
  task being gone now.

### 11.2 Endpoints

All three take the room header from [§3](#3-identifying-a-room) and obey the
room's token rules exactly as `POST /events` does. A server that enforces
plans answers `POST /claims` with the same `402` `seat_limit` as an event
([§2](#2-transport)) for a developer the plan has no seat for, and claims
nothing.

**`POST /claims`**

```json
{ "developer": "alice@example.com", "session_id": "…", "task": "move soft deletes into the user model",
  "paths": ["src/models/user.ts", "src/models/"], "symbols": ["User"], "ttl_minutes": 90,
  "branch": "alice/soft-deletes", "until": "merged" }
```

`201 Created` (`200` with `"renewed": true` for a renewal):

```json
{ "ok": true,
  "claim": { "id": "claim_…", "developer": "…", "task": "…", "paths": [...], "symbols": [...],
             "created_at": "…", "expires_at": "…", "branch": "alice/soft-deletes", "until": "merged" },
  "overlaps": [ { "…another live claim…", "overlap": { "paths": ["src/models"], "symbols": [] } } ] }
```

`paths` are repo-relative, as an event's `file_path` is ([§4.3](#43-file-paths)).
One that is not (absolute, `/…` included, `~/…`, or climbing out with `..`) is
left out of the claim, since the server cannot know where the checkout is, and
a claim with none left is a `400`.

`overlaps` lists **other developers'** live claims that share paths or symbols
with this one, each with exactly what it shares. That field is the point of
the endpoint: a client should show it to its agent before the agent writes.

**`GET /claims`** — every live claim in the room. With `?path=` (or `?paths=a,b`)
and/or `?symbols=`, only claims overlapping those; `?exclude=<developer>`
drops one developer's own. `?developer=<developer>`, the one asking, adds `you`:
every name in the answer that is theirs, lowercased, the one they are shown as
first (a login, where their hooks report a git email the room knows is that
login's). `GET /activity` takes it too, for its sessions, claims and hot files.

**`POST /claims/release`** — `{ "developer", "session_id", "claim_id"?, "all"? }`.
With a `claim_id`, releases that one, from any session of the same person
(`403` if it belongs to someone else, `404` if unknown); without, releases
everything the session holds but its claims until merge, and those too with
`"all": true`. A `claim_id` that is there but is no claim id (`""`, a number,
`null`) is a `400`, never read as "without". A `session_end` releases what a
release without `all` does.
Returns `{ "ok": true, "outcome": "released" | "already_released", "released": n }`.

### 11.3 What the server adds elsewhere

- `GET /check` gains `claimed` (boolean) and `claims` (other developers' live
  claims covering the queried file or symbols). `conflict` keeps meaning "someone
  has *written* here", so an old client's reading of it does not change.
- `GET /activity` gains `claims`, the room's live claims, for dashboards. Every
  claim carries `branch` and `until`.
- `WS /live` sends `{"type":"claim"}`, `{"type":"claim_released"}` and
  `{"type":"claims_released"}` frames, the last with a `reason` and a `branch`
  when a branch settling ended them. A client that only understands
  `"event"` frames ignores them, as [§5](#5-what-the-server-promises) requires.

### 11.4 What a claiming client must do

- Send `session_id` consistently: the same id it uses on `POST /events`, if it
  has one, so a `session_end` releases the claim. A client without a hook-level
  session id mints a stable one per process and releases on exit.
- Claim what it will actually touch. A claim on `src` tells nobody anything.
- Show `overlaps` to the agent, in words, before the agent writes.
- Treat a `404` from `/claims` as "this server predates claims" — proceed
  without them, exactly as for any other failure ([§6](#6-what-a-client-must-do-on-failure)).

---

## 12. Collisions and resolutions — settling what a claim did not prevent

A **collision** is two developers having edited the same file inside the
window. The server can detect one; it cannot fix one, because it never sees
code. What it can do is tell the people involved, at the moment one of their
sessions is about to finish, while they can still decide how the two changes
come together. It never has an agent settle one on its own.

### 12.1 `GET /collisions`

Query: `developer` (optional), `session_id` (optional), `minutes` (default the
server's activity window, capped at retention), `advisory` (optional; `1` from
a client that only ever advises, see `reconcile_mode` below).

- With neither: every open collision in the room, each with its `parties`.
- With `developer`: only collisions that developer is party to, split into
  `mine` and `theirs`, plus `shared_symbols` and `same_branch`.
- With `session_id` as well: only files that session edited. A developer's
  other terminal's files are not this session's to be told about.

```json
{ "reconcile_mode": "approve", "window_minutes": 60,
  "collisions": [ { "file_path": "src/models/user.ts", "key": "src/models/user.ts|alice,bob",
    "mine":   { "developer": "bob",   "branch": "feat/login", "task_hint": "…", "change_summary": "…", "symbols": [...], "minutes_ago": 1 },
    "theirs": [ { "developer": "alice", "branch": "main", "task_hint": "…", "change_summary": "…", "symbols": [...], "minutes_ago": 9 } ],
    "shared_symbols": ["User"], "same_branch": false } ] }
```

`key` is the file plus the set of developers, and it does **not** change when
one of them edits again. A client that speaks once per key says the same
overlap once, however often either side edits the file again.

A named caller that advises also gets the files a teammate's work not merged
yet meets ([§14](#14-work-not-merged-yet--branch-memory)), whenever it was
written, as items with `"kind": "branch"`: the same shape, `theirs` one party
carrying `commit`, `changed_since_commit`, `uncommitted` and `checkout_id`, and a
key of its own, `<file>|<developers>|branch:<their branch>`. With `memory=1`,
all of it, for a client that checks its own history; without, only what [§14](#14-work-not-merged-yet--branch-memory)
gives a client from before it. A file that is a collision in the window already
is that collision.

A party's `task_hint` is the prompt its newest edit of the file was made
under. When that edit had none, an older edit of the same file by the same
session may stand in; another session's never does, since it was doing
something else.

`reconcile_mode` is the room's setting, one of `approve` (default), `auto`,
`off`, changed with `POST /rooms/settings {"reconcile_mode": …}` by a room
admin. `off` means a client says nothing at a session's end; `approve` and
`auto` both mean it says, once, which files overlap whose change, and leaves
what happens to a person. They used to tell the client what to have the agent
do (open a pull request, or commit directly), and the clients that did so block
the agent's finish on any mode but `off`: so the room's setting is answered
only to a request with `advisory=1`, and any other gets `"off"`. `GET
/rooms/self` says what the room is set to either way.

### 12.2 `POST /resolutions`

`{ "developer", "session_id", "file_path", "outcome", "url"?, "note"? }` with
`outcome` one of `pr`, `merged`, `no_conflict`, `dismissed`. The server records
who the parties were from the edits it holds; the caller does not name them.
They include the caller and whoever has work not merged yet open on the file.
What a resolution settles is pairs of people: the caller's side with each
party it has not settled with, as far back as `GET /collisions` looks (a
week), and never two other parties' with each other; from a caller who did
not edit the file in that week, the collision between those who did. Two
parties' collision on a file is closed once a resolution of theirs is **newer
than both of their last edits**, and reopens if either edits the file
afterwards. The `201` answer is `{ "ok", "resolution", "settled": { "with",
"between" }, "still_open" }`: `resolution.developers` names the parties,
settled or not; `settled.with` whom the caller's side was settled with,
`settled.between` the parties it settled with each other (from a caller not in
the collision), and `still_open` whether the file is still a collision between
two others, who go on being told. `GET /activity` attaches to a hot file, as
`resolution`, the newest resolution since its last edit once every two people
on it have settled it, and `WS /live` sends a `{"type":"resolution"}` frame. A server that enforces plans answers
`POST /resolutions` with the same `402` `seat_limit` as an event
([§2](#2-transport)) for a developer the plan has no seat for, and records
nothing.

### 12.3 The Stop client

The Claude Code hooks register a `Stop` hook. As the agent is about to end its
turn it calls `GET /collisions?developer=…&session_id=…&advisory=1`; if there
is an open collision it has not mentioned, it answers `{"systemMessage": …}`, a
note for the person at the keyboard: which files, whose change each meets, when,
on which branch and what for, and that a person decides how the two come
together. It **never blocks** the finish (no `decision`, no exit 2) and never
asks the agent to fetch, branch, commit, push or open a pull request: an agent
kept working on a "reconcile first" did all of that unasked, for a teammate's
change nobody had pushed, and a blocked finish ends a headless run as an error.
It says nothing when `stop_hook_active` is set, never twice for one key in a
session, never when the room's mode is `off`, and never when the server cannot
be reached. The MCP tool `get_collisions` answers the same for an agent that
asks, and asks it to say so in its reply and leave the teammate's change alone.

---

## 13. Streamed diffs — presence by default, code by consent

Everything above describes *that* a file changed. A room may also choose to see
*what* changed, for its live view. The rules, because this is the one place code
crosses the wire:

- A room has a boolean `stream_diffs`, default **false**, changed with
  `POST /rooms/settings {"stream_diffs": true}` by a room admin. `GET /rooms/self`,
  `GET /check` and `GET /activity` all report it.
- An `edit` event may carry `diff: { before, after, truncated, edits }` — the text
  the edit replaced and the text it wrote, each at most 4000 characters
  (`maxLength`, a schema failure beyond it), `truncated` when the client clipped,
  `edits` the number of edits a multi-edit tool made (the diff is the first).
- The server **never stores** the diff. In a room with `stream_diffs` on it is
  broadcast as a sibling of the event on `WS /live` —
  `{"type":"event","event":{…},"diff":{event_id, developer, session_id, file_path,
  tool, before, after, truncated, edits, ts}}` — and kept in a small in-memory ring
  (60) that `GET /activity` returns as `recent_diffs`. Restart, switching the room
  off, or `POST /rooms/purge {"scope":"events"}` empties it.
- In a room with `stream_diffs` off, a `diff` on an event is **ignored**: the event
  is stored, the diff goes nowhere. The room's switch is enforced here, not trusted
  from the client.
- A client must give each developer their own veto. The reference hooks send a diff
  only when the `GET /check` asked before that very edit answered `stream_diffs: true`
  *and* the developer has not set `AGENTMASH_DIFFS=0`; a hook that cannot know the
  room's answer sends nothing, an earlier edit's answer is not this one's, and an
  answer of `false` also holds back any edit told `true` whose text has not gone yet.
- Only `edit` events carry diffs. A diff on any other event type is ignored.

---

## 14. Work not merged yet — branch memory

The window is half an hour. Work on a teammate's own branch is in nobody else's
working tree until that branch merges, which is hours or days later, and that
is when two branches meet. So the server remembers each developer's work on
each branch, file by file, from the `edit` events it already holds, until the
work is merged or the memory horizon passes, and says so wherever it says who
else is in a file. Nothing new is reported for it but whether work has merged.

### 14.1 What is remembered

- Every `edit` with a `file_path` is folded into one row per developer, branch
  and file: the newest edit, the newest commit that included the file (an edit
  in the git client's shape, [§4](#4-the-event): `tool` `git-commit`,
  `session_id` `commit-<short id>`, `change_summary` starting `commit <short
  id>`), the newest edit that was not a commit, and the newest one reported as
  uncommitted (a `tool` of `worktree` or `<client>:worktree`). A commit covers
  the edits up to a second after its timestamp (git dates commits in whole
  seconds).
- Work is **open** while it has not settled ([§14.3](#143-settling)), is newer
  than the horizon, and is on a branch that is named, isn't a detached HEAD's
  short sha, and isn't one work lands on: the room's default branch (GitHub's,
  for a repository connected to the room) and `develop`, `dev`, `trunk` beside
  it, or `main`, `master`, `trunk`, `dev`, `develop` and `default` while the
  room knows none.
- The horizon is `AGENTMASH_MEMORY_DAYS` (default 7), never longer than the
  room keeps its history, nor than its plan does. The rows are pruned with the
  events they sum up and go with them on a purge or a deletion.
- Nobody is told about their own work: not under any name the room knows them
  by, and not work made in the asking checkout (`checkout_id`) under any name.
  A resolution newer than the work, between that teammate and the caller,
  silences it for the caller.
- A room's admin switches it off with `POST /rooms/settings {"branch_memory":
  "off"}`.

### 14.2 Reading it

- **`GET /check?…&branch=…&checkout_id=…&memory=1`** adds `unmerged`: one entry
  per person and branch, five at most, nobody who is a holder in the window
  already, each `{kind: "branch", developer, branch, file_path, last_touched,
  last_ts, minutes_ago, commit, commit_ts, changed_since_commit, uncommitted,
  task_hint, change_summary, checkout_id, edited_since, presence?}`, and
  `memory_days`. `holders` and `conflict` stay the window's. The query
  parameters are read and kept nowhere.
- **`GET /check` without `memory=1`**, which is every client from before it:
  the newest of that work is folded into `holders` as an ordinary holder
  (`match_kind: "file"`, `confidence: "medium"`, `symbols: []`) with the fields
  above, where it is least likely to be wrong for a client that cannot look in
  its history: no older than `AGENTMASH_MEMORY_LEGACY_HOURS` (default 48; `0`
  for none), on a branch the caller never worked on, that the caller has not
  changed the file since, three at most.
- **`GET /team`** adds `unmerged`: teammates' open branches, room-wide, eight at
  most, each `{developer, branch, last_ts, minutes_ago, task_hint, checkout_id,
  files[]}` with up to ten `{file_path, minutes_ago, last_ts, commit,
  changed_since_commit, uncommitted}`. **`GET /activity`** adds the same,
  the caller's own included, and `memory_days`.
- **`GET /collisions`** adds items of `"kind": "branch"` ([§12.1](#121-get-collisions)).
- **`GET /branches?developer=…`** — the caller's own open work, by branch and
  checkout: `{memory_days, branches: [{branch, checkout_id, commits[≤5],
  files[≤50], last_ts}]}`, for the owner's check below. With `claims=1`, also
  each branch the caller holds a claim until merge on and has no open work on:
  `{branch, checkout_id: null, commits: [], files: <the claims' paths>,
  last_ts: <when the newest was made>, claimed: true}`.

A client that checks its history must treat everything in it as untrusted:
pass git a commit only when it is 7 to 40 hex characters, a branch only as
`refs/heads/<name>` and only when shaped like one, a path only after `--`, and
`--end-of-options` before them.

### 14.3 Settling

**`POST /branches/settled`** `{ "developer", "session_id", "state", "branch"?,
"commits"?, "files"?, "dirty"?, "into"?, "checkout_id"?, "at"? }` — the room's token
rules and plan seats apply as for a resolution. `state` is one of:

- `merged` — with `commits` (at most 20, 7 to 40 hex characters each): anyone's
  work whose newest commit is one of them, by its first seven characters, and
  that changed nothing after it. Any client may say this: a teammate's hooks
  that find a commit they were told about in the default branch do. With
  `branch` instead: the caller's own work on it (in `checkout_id`, when given),
  less the files in `dirty`, the ones changed and not committed now.
- `landed` — the files already as the default branch has them (a squash merge,
  a rebase, a revert): with `branch` and `files`, the caller's own; with
  `commits` and `files`, anyone's. `at` (7 to 40 hex characters) names the
  default branch's commit that has them, which `/check` then gives as those
  holders' `commit`.
- `gone` — the caller's own work on a `branch` that was deleted. Only the
  owner can say it.

`into` names the branch merged into; a room that knows no default branch takes
it as its default. Settled work opens again with any edit newer than the
settling. Once no open work is left on a person's branch (or the branch is
gone), their claims until merge on it end (the caller's own `branch` too, when
it had no work in the room, only claims), with `end_reason` `merged` or
`gone`, and `WS /live` sends `{"type":"claims_released", reason, branch}` and
`{"type":"branch_settled"}`. Returns `{ "ok": true, "settled": n,
"claims_released": n }`. Errors: `state must be one of merged, landed, gone`;
`commits must be short commit ids, 7 to 40 hex characters, at most 20`;
`at must be a commit id, 7 to 40 hex characters`;
`branch is required to say a branch is gone`.

### 14.4 What the reference hooks do

- Before an edit, ask with `memory=1`, check each commit named against HEAD
  (`git merge-base --is-ancestor`, three at once, inside what is left of the
  advisory budget, cached per HEAD), say nothing of work HEAD has and nothing
  newer, and say each piece of work once a session. It never blocks, in strict
  mode either. A holder in another working tree whose `commit` HEAD has
  (pulled, merged) is not said at all: their version is in this tree.
- Report a commit made in a session from the reflog (commits and
  cherry-picks only, never a pull, a merge or a rebase), as the git client
  does, unless the git client is installed; both note it first in
  `<gitDir>/agentmash-reported.json`, so neither reports it twice.
- At a prompt, in the background: the developer's own branches that are gone,
  merged, or landed, once in half an hour per checkout, and again whenever a
  fetch has moved a ref work lands on (a pull may have brought a merge).
  Work landed is said with `at`, the default branch's newest commit of its own
  line that changed those files. By the branch: this
  checkout's work, and work from the repository's other checkouts (each noted
  in `<commonDir>/agentmash-checkouts.json` at its prompts, a worktree since
  removed too), five branches of each at most, less a branch another of its
  checkouts has checked out now; a branch only claimed is landed once what it
  changed in the claimed paths is as the default branch has or had it, and
  never for a claim made after its last commit. A branch deleted here is
  looked at by its commits first, for what of it landed, and is then gone:
  this checkout's at once, and another checkout's, or one only claimed that
  the repository had at a prompt, once origin as last fetched has no such
  branch either (one deleted before it was pushed). Work from anywhere else by its
  commits, where the repository has them, three branches at most. Landed
  counts a file the default branch had as the branch has it at a commit since
  they parted, changed again there or not. And the commits this session was
  told about that are in the default branch now.
