# What the client sends

This page lists every network request the client makes: the npm package `agentmash`, built from
`cli/`, `hooks/`, `mcp/`, `clients/`, `digest/` and `crew/` in this repository. For each one it
says when it fires, where it goes and what it carries, with a file reference you can check. Line
numbers drift as the code changes; the function names next to them don't.

## In short

- **One server.** Every first-party request goes to one agentmash server: agentmash.dev, or
  your own.
- **By default** the hooks send the first 500 characters of each prompt you type (secrets
  masked), plus metadata about your work: repo-relative file paths, branch names, commit
  subjects, line counts, the names of functions and exports a change touches, and your
  developer name.
- **Not by default:** the text of your code. Diffs go only when your room turns them on, and
  `AGENTMASH_DIFFS=0` keeps yours home whatever the room says.
- **Third parties** only on specific commands: api.github.com (a public repository check), the
  npm registry (`scan`), and Slack or Telegram (`digest`, when you ask for it).
- **No telemetry.** No analytics, crash reports or usage pings.

## Which server

- The CLI uses `--server`, else `AGENTMASH_SERVER`, else `https://agentmash.dev`
  (`cli/agentmash.mjs:30`).
- Hooks, the MCP server and the git and Cursor clients use the `url` in the repository's
  `.claude/agentmash/config.json` when it has one, otherwise the server you signed in to with
  `npx agentmash login`. `AGENTMASH_URL` overrides both (`hooks/lib.mjs:250-266`, `:781-831`).
- Your machine's sign-in token goes to the server it came from, or to `AGENTMASH_URL` when that
  is set (`hooks/lib.mjs:534-538`, `:804-810`; `cli/agentmash.mjs:262-267`).

## Headers

- Hooks and the MCP server send `x-agentmash-room` (the room key `mash_...` or the room ref
  `rm_...`), `x-agentmash-token` (a per-room developer token, if any), `x-agentmash-user` (the
  machine's sign-in, if any), `x-agentmash-developer-source: env` (only when `AGENTMASH_DEV` is
  set) and `x-agentmash-hooks` (the hooks' version) (`hooks/lib.mjs:1466-1504`,
  `hooks/mcp_coordination.mjs:141-157`).
- The CLI sends the room, token and sign-in headers, plus `x-agentmash-poll` while `login`
  waits for you in the browser (`cli/agentmash.mjs:284-310`). `token` and `inbox` send the
  sign-in as `Authorization: Bearer` and don't follow redirects (`cli/token.mjs:202-214`,
  `cli/inbox.mjs:407-420`).

## Who you are to the room

- `developer`: `AGENTMASH_DEV`, else your signed-in GitHub login, else `git config user.email`,
  else your OS user name (`hooks/lib.mjs:856-867`).
- `session_id`: the agent's own session id.
- `checkout_id`: an HMAC of the host name and the checkout's folder, keyed with a random key
  that stays in `~/.agentmash/checkout-key`. Neither the host name nor the path is sent in a
  readable form (`hooks/lib.mjs:5775-5833`).
- `login` also sends your OS user name as a label for the machine, and the GitHub owner/name of
  the checkout you run it in (`cli/agentmash.mjs:3546-3558`). `init` sends a room label:
  `--label`, or the repository's folder name (`cli/agentmash.mjs:1477-1478`).
- Nothing else about the machine: no machine id, OS details or host name.

## Sent by default

### 1. Your prompt excerpt

| | |
| --- | --- |
| When | Every prompt you type (Claude Code's UserPromptSubmit, or the same event in another agent) |
| Endpoint | `POST /events`, `event_type: prompt` |
| Sends | `task_hint`: the first 500 characters of the prompt, with harness wrapper blocks stripped and known secret patterns masked. Also `prompt_id` (random), `developer`, `session_id`, `tool`, `git_branch`, `timestamp` |
| Again | The same excerpt rides on every edit report and on the session-end event |
| Off | `AGENTMASH_HINTS=0` (the random `prompt_id` still goes) |
| Code | `hooks/user_prompt_submit.mjs:170-178`, `:224-243`; `hooks/lib.mjs:1511` (`PROMPT_CHARS`), `:1202-1225` (the masks); `hooks/post_tool_use.mjs:359`; `hooks/session_end.mjs:95`; Cursor: `clients/cursor/after_file_edit.mjs:295-299` |

The masks cover `sk-`/`pk-` keys, `ghp_`/`github_pat_` tokens, agentmash's own `amu_`/`amp_`/
`mash_` tokens, `AKIA` keys, `AIza` keys, `xox` Slack tokens, JWTs, PEM blocks, `sk_live_`,
`glpat-`, `npm_`, `Bearer` values and `password=` values. Anything else in a prompt, pasted code
included, goes as typed.

Only what a person typed is sent. The agent's replies and its transcript are not. (The
Antigravity adapter reads the end of Antigravity's transcript on your machine to find the last
thing you typed, because that agent passes nothing else: `hooks/dialects/antigravity.mjs:136-184`.)
The first session on a machine in each room shows a one-time note that says this
(`hooks/lib.mjs:4638`, `sharingNote`).

### 2. Edit reports

| | |
| --- | --- |
| When | After each edit tool call on a file inside the repository that git doesn't ignore |
| Endpoint | `POST /events`, `event_type: edit` |
| Sends | `file_path` (repo-relative), `git_branch`, `checkout_id`, `change_summary` (line counts and up to 3 names declared in the edit, such as `+12/-3 lines, touching foo, bar`), `symbols` (up to 24 exported JS/TS names), `prompt_id`, `task_hint` (the prompt excerpt), `agent_type` (a crew agent's name only), `developer`, `session_id`, `tool`, `timestamp` |
| Patches | One report per file, up to 10, with no symbols |
| Code | `hooks/post_tool_use.mjs:341-371`, `:192-240`; `hooks/lib.mjs:1233-1238`, `:1358-1400`, `:3425-3460` |

Files outside the repository, under `.git/`, in other repositories or submodules, and files git
ignores are dropped before any request (`hooks/lib.mjs:1081-1104`, `:6133`).

### 3. The check before an edit

| | |
| --- | --- |
| When | Before each edit tool call, and before a Bash or PowerShell command whose text writes files in the repository. Up to 8 files at once. A file you were just warned about isn't asked again for a minute |
| Endpoint | `GET /check?file_path&developer&symbols&imports&branch&checkout_id&memory=1` (plus session ids with `AGENTMASH_WARN_SELF`) |
| Sends | The repo-relative path, your developer name, up to 60 exported and imported identifier names from the file, the imported names, the branch and `checkout_id`. Names only: no module paths and no code |
| Code | `hooks/pre_tool_use.mjs:215-268`, `:357-361`; `hooks/lib.mjs:3521-3539` |

### 4. Your working tree

| | |
| --- | --- |
| When | A session's first prompt (files already uncommitted), later prompts (files that changed between prompts), and after a Bash or PowerShell command that changed files |
| Endpoint | `POST /events`, `event_type: edit`, `tool: worktree`, up to 10 files a time |
| Sends | File paths (changed tracked files, and new files git doesn't ignore), a summary such as `uncommitted before this session started, last written 2 days ago`, `git_branch`, `checkout_id` |
| Off | `AGENTMASH_WORKTREE=0`. Your agent's own edits are reported either way |
| Code | `hooks/user_prompt_submit.mjs:79-104`; `hooks/post_tool_use.mjs:152-181`; `hooks/lib.mjs:4339`, `:4401-4406`, `:4478-4494` |

### 5. Commits

| | |
| --- | --- |
| When | After `git commit`, from the post-commit hook `init` and `join` install (skip it with `--no-git-hook`). Without that hook, at the next prompt or command, from the reflog |
| Endpoint | `POST /events`, one `edit` per file (up to 50 a commit), then a `session_end` |
| Sends | File paths, line counts, the short SHA, the commit time, `git_branch`, `checkout_id`, and the commit subject (first 200 characters, secrets masked) as `task_hint` |
| Off | `AGENTMASH_HINTS=0` keeps the subject home |
| Code | `clients/git/post_commit.mjs:216-262`; `hooks/lib.mjs:6532-6590` |

### 6. Branch bookkeeping

| | |
| --- | --- |
| When | At prompts, at most every 30 minutes per checkout or when the origin refs moved |
| Endpoints | `GET /branches?developer&claims=1`; then `POST /branches/settled` when local git shows a branch landed, merged or gone |
| Sends | Your developer name; for settled branches: branch names, full commit SHAs, the landed file paths, the default branch's name and SHA, the state, which of those files are uncommitted here, `checkout_id`. This covers teammates' branches whose commits this checkout has, too |
| Code | `hooks/lib.mjs:6682-6691`, `:6895`, `:6911-6939`, `:6937-7035` |

### 7. Reads and session events

| Endpoint | When | Sends | Code |
| --- | --- | --- | --- |
| `GET /team?developer=` | Session start, and at prompts at most once per 10 minutes | Developer name | `hooks/session_start.mjs:121-150`, `hooks/prompt_note.mjs:138-164` |
| `GET /api/v1/lobby/context` | Session start and prompts | Developer name, session ids, branch, up to 50 repo-relative paths this session touched | `hooks/lib.mjs:5041-5070` |
| `GET /collisions?developer&session_id&advisory=1&memory=1` | When the agent finishes a turn, if the session touched files | Developer name, session id | `hooks/stop.mjs:93-102` |
| `POST /events`, `event_type: session_end` | Session end | Developer name, session id, tool, branch, `end_reason`, the prompt excerpt | `hooks/session_end.mjs:86-114` |
| `GET /api/lookup?repo=owner/name` | Hooks from `login`, to find this repository's room. Cached 6 hours, or 10 minutes when there is none | The GitHub owner/name read from the git remote (never the remote URL) and the sign-in | `hooks/lib.mjs:689-695`, `:808` |

## Switches

Set them in your environment. In a repository with a committed install they can also go in
`.claude/agentmash/config.json`; the environment wins. `0`, `false`, `off` and `no` turn a
switch off; `1`, `true`, `on` and `yes` turn it on (`hooks/lib.mjs:225-226`).

| Variable | config.json key | Default | What it does | Code |
| --- | --- | --- | --- | --- |
| `AGENTMASH_HINTS` | `share_hints` | on | Off: prompts and commit subjects stay on your machine | `hooks/lib.mjs:298` |
| `AGENTMASH_DIFFS` | `stream_diffs` | on | Off: your diff text is never sent, whatever the room says | `hooks/lib.mjs:302` |
| `AGENTMASH_WORKTREE` | `share_worktree` | on | Off: names of files your agent didn't change stay on your machine | `hooks/lib.mjs:309` |
| `AGENTMASH_DISABLE` | | off | On: the hooks and the MCP server send nothing at all | `hooks/lib.mjs:275`, `hooks/mcp_coordination.mjs:124` |

`AGENTMASH_HINTS` covers what the hooks send on their own. It doesn't cover text you or your
agent write and send on purpose (below).

## Diffs

- Rooms start with diffs off (the server's `stream_diffs` column defaults to 0). A room turns
  them on with `npx agentmash diffs on` and off with `npx agentmash diffs off`
  (`cli/agentmash.mjs:4680-4709`).
- When the room has them on, its answer to the check before an edit says so, and the edit report
  that follows carries `diff`: the old and new text of the edit, or a Write's new content, up to
  4000 characters a side (`hooks/pre_tool_use.mjs:459-471`, `hooks/post_tool_use.mjs:335-369`,
  `hooks/lib.mjs:1257`, `:1266-1290`).
- Only single-file edits carry it. Patches, Bash changes, commits and Cursor's edits never do.
- The client doesn't mask secrets in diff text.
- `AGENTMASH_DIFFS=0` keeps yours home whatever the room says.
- The server keeps diff text in memory for the room's live view, not in its database.

## Text you or your agent write

These go when you or your agent send them, whatever `AGENTMASH_HINTS` says:

| What | Endpoint | Sends | Code |
| --- | --- | --- | --- |
| MCP `claim_work` | `POST /claims` | A task (up to 300 characters, secrets masked), repo-relative paths (up to 50), names (up to 100), a time to live, the branch | `hooks/mcp_server.mjs:497-550` |
| MCP `mark_resolved` | `POST /resolutions` | The file, an outcome, a pull request URL, a note (up to 500 characters) | `hooks/mcp_server.mjs:697-704` |
| MCP `reply_to_teammate` | `POST /api/v1/lobby/inbox` | A reply to a teammate's request (up to 4000 characters) | `hooks/mcp_server.mjs:786-792` |
| `npx agentmash ask` | `POST /api/v1/lobby/inbox` | A request for a teammate's agent (up to 32,000 characters) | `cli/inbox.mjs:359-393` |
| Strict mode (`AGENTMASH_STRICT`) | `POST /events` | The reason your agent gave for going ahead, on its next edit report | `hooks/lib.mjs:2957-2969` |

Of these, only the `claim_work` task is masked on your machine.

## The MCP server

Your agent calls these tools; each call is one request to the room
(`hooks/mcp_server.mjs:388-797`, through `hooks/mcp_coordination.mjs:141`).

| Tool | Endpoint | Sends |
| --- | --- | --- |
| `who_is_working_on_what`, `has_anyone_touched`, `list_contested_files` | `GET /activity?minutes&developer` | A time window, your developer name. A path you ask about is filtered on your machine, not sent |
| `claim_work` | `POST /claims` | See above |
| `release_claim` | `POST /claims/release` | Developer, session id, a claim id or all of this session's claims. Also sent when the MCP server exits, for claims it made |
| `list_claims` | `GET /claims?developer` | Developer |
| `get_collisions` | `GET /collisions?developer&minutes&advisory=1&memory=1` | Developer, a time window |
| `mark_resolved` | `POST /resolutions` | See above |
| `check_inbox` | `GET /api/v1/lobby/inbox`, `GET /api/v1/room`, `GET /api/v1/me` | The sign-in and the room ref. Answers carry who sent what, never the text |
| `reply_to_teammate` | `POST /api/v1/lobby/inbox` | See above |

## CLI commands

| Command | Endpoints | Sends | Code |
| --- | --- | --- | --- |
| `login` | `POST /auth/cli/start`, then `POST /auth/cli/token` every 2 seconds until you confirm in the browser | Your OS user name as a label, the checkout's GitHub owner/name, the poll token | `cli/agentmash.mjs:3546-3570`, `:3519` |
| `login --room` | `POST /auth/cli/start`, `POST /rooms/tokens` | A name (`AGENTMASH_DEV`, git email or OS user name), the room key | `cli/agentmash.mjs:4590-4640` |
| `logout` | `POST /api/logout` | The sign-in; `all` with `--all` | `cli/agentmash.mjs:3581` |
| `init` | `GET /api/config`, `POST /rooms`, `GET /api/lookup`, `POST /api/connect/room`, `POST /rooms/settings` | The room label, the repository's owner/name, whether a sign-in is required | `cli/agentmash.mjs:1436`, `:1478`, `:1636`, `:1659`, `:1700` |
| `join`, `doctor`, `status`, `git-hook` | `GET /rooms/self`, `GET /healthz`, `GET /activity`, `GET /api/lookup`, `GET /api/whoami` | Room key or sign-in, developer name, the repository's owner/name | `cli/agentmash.mjs:339`, `:1547`, `:2500`, `:2598`, `:2638`, `:3772`, `:3840` |
| `connect`, `disconnect` | `POST /api/connect/room`, `POST /rooms/disconnect` | Room key, sign-in, the repository's owner/name | `cli/agentmash.mjs:4409`, `:4550` |
| `rotate`, `revoke`, `secure`, `reconcile`, `diffs`, `audit`, `purge`, `delete` | `POST /rooms/rotate`, `/rooms/revoke`, `/rooms/tokens/revoke`, `/rooms/settings`, `/rooms/purge`; `GET /rooms/tokens`, `/audit`; `DELETE /rooms` | Room key, the setting you chose | `cli/agentmash.mjs:2960`, `:2993`, `:3007`, `:4669`, `:4699`, `:4735`, `:4755`, `:4788`, `:4810`, `:4820` |
| `token create`, `list`, `revoke` | `POST`/`GET /api/v1/tokens`, `DELETE /api/v1/tokens/:id` | The sign-in; a token name, scopes, repositories, an expiry | `cli/token.mjs:279`, `:304`, `:353` |
| `ask`, `inbox` | `/api/v1/me`, `/api/v1/lobby/inbox` and its `accept`, `deny`, `cancel` | The sign-in, the room ref, the request text you write, a deny reason (up to 300 characters) | `cli/inbox.mjs:519-530`, `:557`, `:623`, `:657`, `:683`, `:697` |
| `digest` | `GET /events?minutes&limit=1000` (paged), `GET /rooms/self` or `/api/v1/room`, `GET /api/config` | Room key or ref, sign-in | `digest/src/net.mjs:81-166` |
| `crew` | none | Nothing. The crew is bundled in the package | `cli/agentmash.mjs:4833-5097` |

## Third parties

- **api.github.com.** Before `init`, `join` or `rotate` commits a room key, the CLI asks
  GitHub's public API whether the repository is public: `GET /repos/{owner}/{name}`, and
  `GET /users/{owner}` on some `connect` errors. Unauthenticated, with the user agent
  `agentmash-cli`. Only the owner and name are sent (`cli/visibility.mjs:12-113`; called from
  `cli/agentmash.mjs:1458`, `:1789`, `:2958`, `:4237`, `:4309`, `:4339`, `:4447`).
- **The npm registry.** `npx agentmash scan` runs the separate `agentmash-scan` package through
  `npm exec --yes`, which downloads it on first use unless a local copy is found or
  `AGENTMASH_SCAN_BIN` points at one (`cli/scan.mjs:30`, `:58-65`). That package isn't in this
  repository. The MCP launcher fetches `agentmash` through `npx` only if you set
  `AGENTMASH_MCP_NPX=1` and no local copy loads (`hooks/mcp_launcher.mjs:59-71`).
- **Slack or Telegram.** `npx agentmash digest --to slack` or `--to telegram` (not with
  `--dry-run`) posts the digest to the webhook or bot you give it: developer names, branches,
  the busiest files and folders, and counts. Prompt text only with `--include-hints`. A
  dashboard link only with `--link`; on a server without GitHub sign-in that link contains the
  room key (`digest/src/net.mjs:127-192`).
- **Your browser.** The CLI opens your browser on the server's sign-in page and on dashboard
  links (`cli/agentmash.mjs:3349-3362`).

## No telemetry

There is no analytics, crash reporting or usage ping anywhere in the client, and the package has
no runtime dependencies. A report that fails is written to a local log,
`~/.agentmash/log/reports.jsonl`, which `doctor` reads on your machine
(`hooks/lib.mjs:3894-3916`). The only version information sent is the `x-agentmash-hooks`
header.

## What stays on your machine

- File contents, unless your room has diffs on.
- The agent's replies and transcript.
- `~/.agentmash/checkout-key`, `rooms.json` (a cache of room lookups), `told.json`, the
  failed-report log, and each agent adapter's small state files.
- Per-session scratch files under your temp folder, in `agentmash/`.
- Host names and folder paths, except as the keyed hash in `checkout_id`.
