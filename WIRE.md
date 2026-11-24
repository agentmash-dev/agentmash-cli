# What the client sends

This page lists every network request the client makes: the npm package `agentmash`, built from
`cli/`, `hooks/`, `mcp/`, `clients/`, `digest/` and `crew/` in this repository. For each one it
says when it fires, where it goes and what it carries, with a file reference you can check, written
`file:line function`. Line numbers drift as the code changes; the function names next to them
don't.

## In short

- **Your agentmash server.** Every first-party request goes to an agentmash server: agentmash.dev,
  or one that a `--server` flag, your environment, your repository's config, a link you paste or
  the server's own answer names. A room given with no address goes to `http://127.0.0.1:8787`
  from the hooks, the MCP server and the git and Cursor clients, and to `AGENTMASH_SERVER`, else
  agentmash.dev, from `digest` ([Which server](#which-server)).
- **By default** the hooks send the first 500 characters of each prompt you type (secrets
  masked), plus metadata about your work: repo-relative file paths (including files changed in
  your working tree by hand or by a command), branch names, commit subjects, line counts, the
  names a file being edited exports and imports and the names an edit declares, the repository's
  GitHub owner/name, and your developer name.
- **Not by default:** the text of your code. Diffs go only when your room turns them on, and
  `AGENTMASH_DIFFS=0` keeps yours home whatever the room says.
- **Observing, off until you run `npx agentmash observe on`.** With it on, your prompts, your
  agent's tool calls (the text of its edits and the output of its commands included) and its
  closing message go to a model through your own `claude` command, and the short findings that
  model writes go to your room once the room asks for them ([Observing](#observing)).
- **Third parties** only on specific commands or settings: GitHub's API (whether a repository is
  public or an owner is an organization), the npm registry (`scan`, the MCP launcher when you set
  `AGENTMASH_MCP_NPX=1`, and `doctor` when `.mcp.json` starts agentmash with `npx`), the webhook or
  bot you give `digest`, whoever your `claude` command talks to when observing is on, and, in a
  partial clone, your git remote, which git itself asks for
  objects the checkout lacks when the hooks or the MCP server look in its history: in the branch
  check at prompts, and for a commit a room's answer names, before an edit included.
- **No telemetry.** No analytics, crash reports or usage pings.

## Which server

- **Hooks, the MCP server and the git and Cursor clients**, in a repository with its own install
  (`.claude/agentmash/config.json`), or wherever `AGENTMASH_ROOM` is set: `AGENTMASH_URL` from
  your environment, else from the checkout's `.env`, else from `.claude/agentmash/.env`, else
  `url` in config.json, else `http://127.0.0.1:8787` (`hooks/lib.mjs:266 loadConfig`,
  `:254 loadConfig`). Those `.env` files can also set `AGENTMASH_ROOM`, `AGENTMASH_TOKEN`,
  `AGENTMASH_DEV` and the switches, so a checkout's `.env` that names a room sends that checkout's
  reports to the server it names, from a signed-in machine too (`hooks/lib.mjs:804 resolveConfig`).
- **On a machine signed in with `login`**, in a checkout with no room of its own, they look the
  repository up and send everything to the server that answered: `AGENTMASH_URL` from your
  environment (a `.env` does not count here), else the server in `~/.agentmash/user.json`
  (`hooks/lib.mjs:809 resolveConfig`; `hooks/mcp_coordination.mjs:66 resolveCoordination`,
  `clients/git/post_commit.mjs:171 main`, `clients/cursor/after_file_edit.mjs:103 configFor`).
  Started in a folder below a repository's own install, they use that install's room only when it
  is on the server the machine signed in to (`hooks/lib.mjs:795 resolveConfig`). In a repository
  with its own install, the signed-in machine's Claude Code hooks step aside for the committed
  ones, and its other agents' hooks report to the repository's room (`:803 resolveConfig`).
- **The CLI** reads no `.env` file to choose its server. Per command:

| Commands | Server |
| --- | --- |
| `init` | `--server`, else `AGENTMASH_SERVER`, else `https://agentmash.dev`; after `POST /rooms`, the `server_url` that server answers (`cli/agentmash.mjs:31 DEFAULT_SERVER`, `:1491 cmdInit`) |
| `join` | The host of a pasted dashboard link (`https://host/r/mash_...`), else as `init` (`cli/agentmash.mjs:1757 cmdJoin`) |
| `login` | `--server`, else `AGENTMASH_SERVER`, else the server this machine is signed in to, else `https://agentmash.dev` (`cli/agentmash.mjs:3446 cmdLoginMachine`); in a checkout whose config.json has a room, also `GET /rooms/self` to `AGENTMASH_URL`, else config.json's `url` (`:4803 roomSplit`) |
| `doctor`, `status`, `login --room`, `rotate`, `revoke`, `connect`, `disconnect`, `secure`, `reconcile`, `diffs`, `observe share`, `audit`, `purge`, `delete` in a set-up repository | `AGENTMASH_URL`, else config.json's `url` (`cli/agentmash.mjs:392 connection`) |
| Bare `npx agentmash`, and `init` in a repository already set up | config.json's `url` (`cli/agentmash.mjs:6362 main`, `:1386 cmdInit`) |
| `doctor` outside a set-up repository, `git-hook` | `AGENTMASH_URL`, else the sign-in's server (`cli/agentmash.mjs:3925 doctorMachine`, `:2933 sayGitHookRoom`) |
| `status` outside a set-up repository, `logout`, `token`, `ask`, `inbox` | The sign-in's server (`cli/agentmash.mjs:3858 statusMachine`, `:3661 cmdLogout`; `cli/token.mjs:181 serverOf`; `cli/agentmash.mjs:6220 inboxRoom`) |
| `digest` | `--server`, else `AGENTMASH_URL`, else config.json's `url`; a room with none of those, `AGENTMASH_SERVER` or `https://agentmash.dev`; no room, the sign-in's server (`digest/src/cli.mjs:167 resolveRoom`, `cli/agentmash.mjs:6289 digestRoom`) |

- **Your machine's sign-in token** goes to the server it came from, and to no other, with two
  exceptions: when `AGENTMASH_URL` is set in your environment, the hooks, the MCP server and the
  git and Cursor clients send it there with the repository lookup and with every request to the
  room the lookup finds (the MCP server's inbox and task tools included), and `doctor` and
  `git-hook` outside a set-up repository send it there too; and a server that answers with a
  redirect gets it sent on (Headers, below) (`hooks/lib.mjs:537 withSignIn`, `:809 resolveConfig`,
  `:832 resolveConfig`; `cli/agentmash.mjs:263 signInBesideKey`).

## Headers

- **Hooks, the MCP server, the git and Cursor clients** always send `content-type:
  application/json`, `x-agentmash-hooks` (the hooks' version, `0.16.1`; a repository's committed
  copy sends its own) and `connection: close`, and, on every request but the MCP server's task
  tools' (below), `x-agentmash-room` (the room key `mash_...` or ref `rm_...`; present and empty
  on the lookup). They add `x-agentmash-token` (a per-room developer token from
  `AGENTMASH_TOKEN` or `~/.agentmash/credentials.json`; never on a room found by the lookup),
  `x-agentmash-user` (the machine's sign-in, as above) and `x-agentmash-developer-source: env`
  when `AGENTMASH_DEV` is set in your environment or a `.env`, and also on every room request
  from a machine whose room the lookup found, where the developer is the name the lookup answered
  (`hooks/lib.mjs:1478 request`, `:833 resolveConfig`; `hooks/mcp_coordination.mjs:141 requestJson`).
  The observing worker's requests go through the same function, with the same headers
  (`hooks/observe_sync.mjs:314 syncKey`).
- The MCP server's inbox requests, once it knows the room's ref, send that ref and the sign-in:
  no key, token or developer-source (`hooks/mcp_server.mjs:302 inboxAccess`). Its task tools send
  `x-agentmash-user` and `x-agentmash-hooks` beside `content-type` and `connection: close`, and no
  room, key or token; a write (`task_create`, `task_update`, `task_comment`) adds
  `x-agentmash-agent`, the kind of agent its MCP client said it is when it connected (`claude`,
  `codex`, `cursor` and the like, else `agent`), and `x-agentmash-agent-session`,
  `AGENTMASH_LOBBY_SESSION` when that is set to a desktop-app session id
  (`hooks/mcp_server.mjs:497 ask`, `:1940 respondTo`; `hooks/lib.mjs:6041 lobbySessionId`).
- The CLI's requests to an agentmash server, but for `token`'s, `digest`'s own and those `inbox`
  and `ask` make once they know their room, all go through one function. It always sends
  `x-agentmash-room` (empty where there is no room) and `connection: close`, and adds
  `content-type` with a body, the room's developer token where there is one, `x-agentmash-poll`
  while a sign-in waits for you in the browser, and the sign-in where a command uses it or beside
  a `mash_` key to the server it came from. It sends no `x-agentmash-hooks`
  (`cli/agentmash.mjs:290 api`, `:263 signInBesideKey`). `ask`, `inbox` and `digest` find their
  room through it too: `GET /api/lookup` with the sign-in as `x-agentmash-user`, or, for `ask`
  and `inbox`, `GET /api/v1/room` with the room key, token and sign-in
  (`cli/agentmash.mjs:6226 inboxRoom`, `:6253 signedInRoom`). After that, `inbox` and `ask`, and
  `token` throughout, send the sign-in as `Authorization: Bearer` (`inbox` and `ask` add the room
  ref) and don't follow redirects (`cli/token.mjs:202 call`, `cli/inbox.mjs:407 call`). `digest`
  sends the room and, where it has one, the sign-in; its `GET /api/config` and its posts to Slack
  or Telegram carry neither (`digest/src/net.mjs:63 credentials`). GitHub gets `accept`,
  `user-agent: agentmash-cli` and `x-github-api-version`, and no credentials
  (`cli/visibility.mjs:32 repoVisibility`).
- Node's `fetch` adds its standard headers (on Node 24: `user-agent: node`, `accept`,
  `accept-language`, `accept-encoding`, `sec-fetch-mode`).
- Every request but those sent with `Authorization: Bearer` follows HTTP redirects, as `fetch`
  does (the requests `ask` and `inbox` find their room with included), and on Node 24 a redirect
  to another host keeps the `x-agentmash-*` headers: a server that redirects hands your room key,
  token and sign-in to wherever it points.

## Who you are to the room

- `developer`: `AGENTMASH_DEV` (environment or `.env`); on a machine whose room the lookup found,
  the name the lookup answers; else your signed-in GitHub login, when the sign-in is for that
  server; else `git config user.email`; else your OS user name (`hooks/lib.mjs:862 getDeveloper`,
  `:821 resolveConfig`). The CLI's `login --room` names you by `AGENTMASH_DEV`, else the git
  email, else the OS user name (`cli/agentmash.mjs:1805 identity`); `doctor` too, or by your
  signed-in login when the sign-in is for that server and `AGENTMASH_DEV` is unset
  (`:2523 cmdDoctor`).
- `session_id`: the agent's own session id. Commits go under `commit-<short SHA>`. The MCP server
  uses Claude Code's session id, else (with `AGENTMASH_WARN_SELF`) `lobby:` and the desktop
  app's session, else a random id (`hooks/mcp_server.mjs:150 sessionId`).
- `checkout_id`: an HMAC of the host name and the checkout's folder, keyed with a random key
  that stays in `~/.agentmash/checkout-key`. Neither the host name nor the path is sent in a
  readable form (`hooks/lib.mjs:6767 checkoutId`).
- `repo`: on every event sent to `POST /events` (prompts, edit reports, working-tree reports,
  commits, session ends; the git post-commit hook's and the Cursor adapter's too), the GitHub
  owner/name of the checkout, read from the git config: the origin remote, or the only GitHub
  remote. Never the remote URL, and nothing outside a GitHub checkout (`hooks/lib.mjs:514 repoSlug`, `:4179 reportEvent`).
- `subagent`: on the edit reports a subagent makes (Claude Code's, or one another agent names
  through the generic hook: an OpenCode or Kilo child session, a Cline subagent), the first 16
  hex characters of a SHA-256 of the session id and the subagent's own id, the same on each of
  its reports. The working-tree reports after a subagent's command don't carry it. Nothing
  else of the subagent is sent: not its own id, its prompt, or its name unless it is a crew agent
  (then `agent_type`) (`hooks/lib.mjs:4751 subagentRef`, `hooks/post_tool_use.mjs:76 report`,
  `:287 main`; `hooks/agent_hook.mjs:392 claudeInput`,
  `hooks/dialects/opencode.mjs:98 parseOpencode`, `hooks/dialects/kilo.mjs:118 parseKilo`,
  `hooks/dialects/cline.mjs:103 whereOf`).
- `tool`: the tool an event came from. Hooks run for another agent with `--client` put that
  agent's name in front (`codex:Bash`), and send the name alone on a prompt or a session end;
  Devin runs Claude Code's hooks, and its `write`, `edit` and `apply_patch` go as `devin:edit`
  and the like (`hooks/lib.mjs:6655 clientTool`, `:6646 DEVIN_TOOLS`).
- `login` also sends your OS user name as a label for the machine, and the GitHub owner/name of
  each GitHub remote of the checkout you run it in; `connect`'s new sign-in, the repository it
  connects (`cli/agentmash.mjs:3627 signInMachine`, `:3458 cmdLoginMachine`, `:5191 cmdConnect`).
  `login --room` sends the CLI's name for you, above, as its label.
  `init` sends a room label: `--label`, or the repository's folder name
  (`cli/agentmash.mjs:1479 cmdInit`).
- Commit reports carry the commit time as git records it, with the committer's UTC offset
  (`hooks/lib.mjs:7508 reportCommits`, `clients/git/post_commit.mjs:180 main`).
- Nothing else about the machine: the client's own requests carry no machine id, OS details or
  host name.

## Sent by default

### 1. Your prompt excerpt

| | |
| --- | --- |
| When | Every prompt you type (Claude Code's UserPromptSubmit, the same event in another agent, Cursor's beforeSubmitPrompt). A turn nobody typed (a background task's notification) sends none |
| Endpoint | `POST /events`, `event_type: prompt` |
| Sends | `task_hint`: the prompt with harness wrapper blocks stripped, known secret patterns masked, whitespace collapsed, cut to 500 characters. Also `prompt_id` (random), `developer`, `session_id`, `tool`, `git_branch`, `repo`, `timestamp`, `report_id` (random, the same on a later attempt at this report: [Reports kept for later](#reports-kept-for-later)). Cursor's sends no `prompt_id` |
| Again | The same excerpt rides on every edit report and on the session-end event |
| Off | `AGENTMASH_HINTS=0` (the random `prompt_id` still goes) |
| Code | `hooks/user_prompt_submit.mjs:178 main`, `:226 main`; `hooks/lib.mjs:3888 userPromptText`, `:1520 PROMPT_CHARS`, `:1208 SECRET_PATTERNS`, `:1233 truncate`; `hooks/post_tool_use.mjs:373 main`; `hooks/session_end.mjs:95 main`; `clients/cursor/after_file_edit.mjs:309 main` |

The masks cover `sk-`/`pk-`/`rk-` keys, `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_` tokens,
agentmash's own `amu_`/`amp_`/`mash_` tokens, `AKIA` keys, `AIza` keys, `xox` Slack tokens, JWTs,
PEM blocks, `sk_live_`/`rk_live_`, `glpat-`, `npm_`, `Bearer` values and `password`/`passwd`
values after `=` or `:`. Anything else in a prompt, pasted code included, goes as typed.

Only what a person typed is sent, pasted blocks included. The agent's replies and its transcript
are not, unless you turned observing on ([Observing](#observing)). (The Antigravity adapter reads the end of Antigravity's transcript on your machine to
find the last thing you typed, because that agent passes nothing else:
`hooks/dialects/antigravity.mjs:136 lastUserInput`.) Claude Code's first session on a machine in
each room shows a one-time note saying what goes to the room (`hooks/lib.mjs:5580 sharingNote`).

### 2. Edit reports

| | |
| --- | --- |
| When | After each edit tool call on a file inside the repository that git doesn't ignore. Crush's are sent by a watcher once the file changes (up to 5 minutes later, 30 with `AGENTMASH_CRUSH_WATCH_MS`), Junie's at its next edit or turn end |
| Endpoint | `POST /events`, `event_type: edit` |
| Sends | `file_path` (repo-relative), `git_branch`, `checkout_id`, `change_summary` (up to 300 characters: line counts and up to 3 names declared in the edit, such as `+12/-3 lines, touching foo, bar`), `symbols` (up to 24 exported JS/TS names), `prompt_id`, `task_hint` (the prompt excerpt), `agent_type` (a crew agent's name only), `subagent` (a subagent's edits only), `repo`, `developer`, `session_id`, `tool`, `timestamp`, `report_id`; `diff` only where your room streams diffs (below) |
| Patches | A patch, or one call that edits several files: one report per file, up to 10, with no symbols or diff. A move names its other end only by a repo-relative path |
| Cursor | The same fields but `symbols`, `prompt_id`, `agent_type`, `subagent` and `diff` |
| Code | `hooks/post_tool_use.mjs:355 main`, `:225 reportFiles`; `hooks/lib.mjs:1366 summarizeChange`, `:3153 composeSummary`, `:3599 symbolsForEdit`, `:6693 summarizePatchedFile`; `hooks/dialects/crush.mjs:262 watchFor`, `hooks/dialects/junie.mjs:349 reportLanded`; `clients/cursor/after_file_edit.mjs:342 main` |

Files outside the repository, under `.git/`, in other repositories or submodules are never reported
or asked about (`hooks/lib.mjs:1087 locateInRepo`). Nor is a file git ignores, as long as git says so
within half a second. With no git to run, a slow one, or one that refuses the repository, the file
may be an ignored one, so it is asked about and reported by its path and line counts alone: no
`diff` whatever the room streams, no `symbols` or imported names, and no names in
`change_summary` (`hooks/lib.mjs:7083 gitIgnoreAnswers`; `hooks/pre_tool_use.mjs:459 checkFile`,
`hooks/post_tool_use.mjs:327 main`, `clients/cursor/after_file_edit.mjs:340 main`).
On a signed-in machine, the repository lookup (section 7) can still go out before git is asked
whether a file is ignored, or before a command's files are known; it names no file
(`hooks/post_tool_use.mjs:315 main`, `:292 main`).

### 3. The check before an edit

| | |
| --- | --- |
| When | Before each edit tool call, and before a Bash or PowerShell command whose text writes files in the repository. Up to 8 files at once. A file you were warned about in the last 10 minutes isn't asked again within a minute of the last ask, except in strict mode or while your room streams diffs and `AGENTMASH_DIFFS` is on. After two checks in a row that a server left unanswered, Claude Code's hook asks nothing for 15 seconds, then 30, then 60 at a time, until a check is answered; the count is kept in `~/.agentmash/health/` and sent nowhere |
| Endpoint | `GET /check?file_path&developer&symbols&imports&branch&checkout_id&memory=1` (plus `findings_for`, the agent's session id, on the first file of a check, so the room can answer with up to three things teammates' agents found and not tell them to this session twice; and `self`, `session_id` and `lobby_session` with `AGENTMASH_WARN_SELF`) |
| Sends | The repo-relative path, your developer name, up to 60 identifier names (the file's exports, or those this edit changes, and its imports), up to 60 imported names, the branch and `checkout_id`, all in the query string. Names only: no module paths and no code. Cursor's check sends the path, developer and names only |
| Off | `AGENTMASH_FINDINGS=0` in your environment sends no `findings_for` |
| Code | `hooks/pre_tool_use.mjs:497 checkFile`, `:204 HEARS_FINDINGS`; `hooks/lib.mjs:5036 checkBreaker`, `:4956 checkHealthPath`; `hooks/pre_tool_use.mjs:511 checkFile`, `:613 main`, `:669 main`; `hooks/lib.mjs:3695 bindingsForFile`; `clients/cursor/after_file_edit.mjs:185 adviseBeforeEdit` |

### 4. Your working tree

| | |
| --- | --- |
| When | Every prompt, typed or not: at a session's first, the tracked files already uncommitted; at later ones, files that changed since the last look. And after a Bash, PowerShell or `run_in_terminal` command, the files that changed since the last look. Files some hook already reported as they are now are left out |
| Endpoint | `POST /events`, `event_type: edit`, up to 10 files a time. `tool` is `worktree` for the ones at a prompt, and the command's tool name (such as `Bash`) for the ones after a command; hooks run for another agent with `--client` put its name in front (`codex:worktree`, `codex:Bash`) |
| Sends | File paths (changed tracked files, and new files git doesn't ignore), a summary such as `uncommitted before this session started, last written 2 days ago`, `git_branch`, `checkout_id`, `repo`, `developer`, `session_id`. After a command, also the prompt excerpt (`task_hint`, kept home by `AGENTMASH_HINTS=0`), `prompt_id` and `agent_type` (a crew agent's name only) |
| Off | `AGENTMASH_WORKTREE=0` withholds the ones at a prompt. The ones after a command are reported either way, a file you changed by hand since the last look included |
| Code | `hooks/user_prompt_submit.mjs:88 catchUp`, `:203 main`; `hooks/post_tool_use.mjs:176 reportLook`; `hooks/lib.mjs:5311 worktreeLook`, `:5420 reportChangedFiles`, `:6655 clientTool` |

### 5. Commits

| | |
| --- | --- |
| When | After `git commit`, from the post-commit hook `init`, `join` and `git-hook` install (skip it with `--no-git-hook`). Without that hook, at the next prompt (typed or not) or command, from the reflog: up to 5 commits or cherry-picks made on the branch the session last saw |
| Endpoint | `POST /events`, one `edit` per file (up to 50 a commit), then a `session_end`; `session_id` `commit-<short SHA>`, `tool` `git-commit` |
| Sends | File paths, line counts, the short SHA, the commit time (with the committer's UTC offset), `git_branch`, `checkout_id`, `developer`, and the commit subject (first 200 characters, secrets masked) as `task_hint`, `repo` and `report_id` |
| Off | `AGENTMASH_HINTS=0` keeps the subject home |
| Code | `clients/git/post_commit.mjs:268 main`, `:287 main`; `hooks/lib.mjs:7485 commitsSinceLastLook`, `:7549 reportCommits`, `:7561 reportCommits`; `hooks/user_prompt_submit.mjs:134 branchWork`; `hooks/post_tool_use.mjs:160 reportNewCommits` |

### 6. Branch bookkeeping

| | |
| --- | --- |
| When | At prompts, typed or not, in a checkout with origin refs fetched: at most every 30 minutes per checkout, or when those refs moved, `GET /branches` and then `POST /branches/settled` for each branch local git shows landed, merged or gone. And at every prompt, with no wait and no `GET` first, `POST /branches/settled` for up to 5 commits this session was warned about that are now merged |
| Endpoints | `GET /branches?developer&claims=1`; `POST /branches/settled` |
| Sends | Your developer name; for settled branches: `session_id`, the state, branch names, commit SHAs, the landed file paths, the default branch's name and the commit of it that has them, which of those files are uncommitted here, `checkout_id`. This covers teammates' branches whose commits this checkout has, too |
| Code | `hooks/user_prompt_submit.mjs:135 branchWork`; `hooks/lib.mjs:7863 ownerMergeCheck`, `:7865 ownerMergeCheck`, `:7653 settle`, `:8005 mergedCheck` |

### 7. Reads and session events

| Endpoint | When | Sends | Code |
| --- | --- | --- | --- |
| `GET /team?developer=` | Session start, and at typed prompts at most once per 10 minutes (not where the desktop app's block answered) | Developer name | `hooks/session_start.mjs:137 main`, `hooks/prompt_note.mjs:108 main`, `:158 main` |
| `GET /api/v1/lobby/context` | Session start; at typed prompts at most once per 10 minutes, for a session the room gave its block | Developer name, the agent's session id, `AGENTMASH_LOBBY_SESSION`, branch, up to 50 repo-relative paths this session changed | `hooks/lib.mjs:6001 lobbyContext`; `hooks/prompt_note.mjs:137 main` |
| `GET /collisions?developer&session_id&advisory=1&memory=1` | When the agent finishes a turn, if the session changed files | Developer name, session id | `hooks/stop.mjs:73 main`, `:96 main` |
| `POST /events`, `event_type: session_end` | Session end | Developer name, session id, tool, branch, `end_reason`, the prompt excerpt, `repo`, `report_id`. Cursor's: no `end_reason` | `hooks/session_end.mjs:104 main`, `clients/cursor/after_file_edit.mjs:314 main` |
| `GET /api/lookup?repo=owner/name` | On a machine signed in with `login`, in a checkout with no room of its own: the hooks (before their first request), the MCP server at its tool calls (before any path is checked) and at its exit, each commit's git hook, Cursor's hooks with `--global`. Cached in `~/.agentmash/rooms.json`: 6 hours when found; when not, 45 seconds for the prompt's report, the after-tool hooks, Cursor's reports and the MCP server, 10 minutes for the rest, the prompt's heads-up included; a request with no answer is not cached, and a room that turns a hook's request away (401 `room_unauthorized` or `reauth`) is forgotten | The GitHub owner/name read from the git config (never the remote URL), in the query string, and the sign-in; `x-agentmash-room` empty | `hooks/lib.mjs:814 resolveConfig`, `:699 readRoomCache`, `:1508 request`; `hooks/prompt_note.mjs:113 main`; `hooks/mcp_server.mjs:238 coordinationNow` |

## Switches

Set them in your environment or a checkout's `.env` (or `.claude/agentmash/.env`). In a repository
with a committed install they can also go in `.claude/agentmash/config.json`; the environment
wins. `0`, `false`, `off` and `no` turn a switch off; `1`, `true`, `on` and `yes` turn it on; any
other value turns the first three off and `AGENTMASH_DISABLE` on (`hooks/lib.mjs:234 envSwitch`).

| Variable | config.json key | Default | What it does | Code |
| --- | --- | --- | --- | --- |
| `AGENTMASH_HINTS` | `share_hints` | on | Off: prompts and commit subjects stay on your machine | `hooks/lib.mjs:298 loadConfig` |
| `AGENTMASH_DIFFS` | `stream_diffs` | on | Off: your diff text is never sent, whatever the room says | `hooks/lib.mjs:302 loadConfig` |
| `AGENTMASH_WORKTREE` | `share_worktree` | on | Off: the files found changed at a prompt stay on your machine. After a command, every file changed since the last look is still reported as that command's, hand edits in the meantime included | `hooks/lib.mjs:309 loadConfig`, `hooks/user_prompt_submit.mjs:86 catchUp`, `hooks/post_tool_use.mjs:164 reportLook` |
| `AGENTMASH_DISABLE` | | off | On: the hooks, the MCP server and the git and Cursor clients send nothing at all, kept reports stay where they are, and the observing hooks record nothing. An observing worker that is already running goes on until it has been idle five minutes | `hooks/lib.mjs:294 loadConfig`, `hooks/mcp_coordination.mjs:126 requestJson`, `hooks/mcp_server.mjs:287 inboxAccess`, `hooks/observe_spool.mjs:56 switchedOff` |
| `AGENTMASH_FINDINGS` | | on | Off: the check before an edit doesn't ask for what teammates' agents found. Read from your environment only | `hooks/pre_tool_use.mjs:204 HEARS_FINDINGS` |
| `AGENTMASH_OBSERVE_SHARE` | `"share"` in `~/.agentmash/observe.json` (`npx agentmash observe local on`) | on | Off: what observing finds on this machine goes to no room. Read from your environment only | `hooks/observe.mjs:192 vetoesSharing` |

`AGENTMASH_HINTS` covers what the hooks send on their own. It doesn't cover text you or your
agent write and send on purpose (below), or what observing hands a model once you turn it on.

## Diffs

- Rooms start with diffs off. A room turns them on with `npx agentmash diffs on` and off with
  `npx agentmash diffs off` (`cli/agentmash.mjs:5986 usage`, `:5458 cmdDiffs`).
- When the room has them on, its answer to the check before an edit says so, and the edit report
  that follows carries `diff`: the old and new text of the edit (a multi-edit's first), or a
  Write's new content, up to 4000 characters a side (`hooks/pre_tool_use.mjs:763 main`,
  `hooks/post_tool_use.mjs:352 main`, `hooks/lib.mjs:1263 DIFF_CHARS`, `:1272 diffForEdit`).
- Only single-file edits carry it. Patches, commands' changes, commits and Cursor's edits never do.
- The client doesn't mask secrets in diff text.
- `AGENTMASH_DIFFS=0` keeps yours home whatever the room says.
- `npx agentmash diffs` tells you the server keeps diff text in memory for the live view, never on
  disk (`cli/agentmash.mjs:5446 cmdDiffs`).

## Observing

Off by default. `npx agentmash observe on` turns it on for this machine's Claude Code sessions,
in every repository: it adds hooks to Claude Code's own settings and writes
`~/.agentmash/observe.json`. `observe off` and `logout` take both away
(`hooks/observe.mjs:95 DEFAULT_CONFIG`; `cli/agentmash.mjs:4407 observeOn`,
`:4219 turnObservingOff`).

**What is recorded.** While it is on, a hook writes each prompt (up to 6000 characters), each
tool call (the tool's name, up to 8 fields of its input at 2000 characters each, and its outcome
up to 4000 characters) and the end of the agent's closing message (4000 characters) to
`~/.agentmash/observe/spool/`, with known secret patterns masked. A tool's input is recorded as
it is, so the old and new text of an edit and the content of a written file are there; what a
tool answers with of a file's own text is not, and a read is recorded as a line count
(`hooks/observe.mjs:213 toolInput`, `:224 toolOutcome`). `AGENTMASH_HINTS` and `AGENTMASH_DIFFS`
don't apply here. The spool is emptied after a day.

**What goes to a model.** A worker the hook starts runs your own `claude` command
(`claude -p`, no tools, model `claude-haiku-5-5` or the one `observe.json` names) in an empty
temp folder, under your Claude sign-in, at most one run at a time and 300 a day. agentmash adds
no key of its own and makes no request to a model itself; where that text goes from there is
your `claude` command's doing. A run is handed one of three things
(`hooks/observe_worker.mjs:356 observerCommand`, `:428 runObserver`):

- a batch of a session's recorded events, as above, with the repository's owner/name, the branch,
  and up to 12 findings the session was told and 12 of teammates' findings
  (`hooks/observe.mjs:647 renderBatch`);
- a prompt of 40 characters or more with up to 40 findings, to pick which to tell the session
  (`:2610 renderBriefAsk`);
- a prompt with up to 400 findings' titles, where there are more findings than one such run
  takes (`:2670 renderShortAsk`).

**What goes to your room.** The worker asks each observed repository's room
`GET /observations?limit=500`, about every 30 seconds while it runs, whether or not the room
shares; that request carries the usual headers and nothing else, and the answer (the room's
findings) is cached in `~/.agentmash/observe/team/`. It sends `POST /observations` only when
that answer said the room shares (`share_observations`, which a room admin turns on with
`npx agentmash observe share on`), this machine hasn't said no (`observe local on` or
`AGENTMASH_OBSERVE_SHARE=0`), and the finding was made after the room began sharing. The body is
`developer`, `repo` and up to 50 entries (`hooks/observe_sync.mjs:354 syncKey`, `:422 syncKey`,
`:270 wireEntry`, `:214 wireObservation`; `hooks/observe.mjs:1657 pendingLines`):

| Entry | Carries |
| --- | --- |
| `add` | A finding the model wrote: `id`, `type`, `title` (up to 120 characters), one to three `facts` (up to 240 each; one can be a sentence of your prompt word for word), up to 8 repo-relative `files` with their git blob ids and 8 `symbols`, `evidence` (a kind and a reference of up to 200 characters, which can be a command), `branch`, `head` (the commit), `checkout_id`, the agent's `session_id`, `agent`, the observer `model`, and the times of the batch it came from. Paths under the checkout go as relative ones, your home folder as `~`, and secrets are masked again |
| `seen` | `id` and a time: a finding found again |
| `forget` | `id` and a time: `npx agentmash observe forget <id>`. The only entry that also goes to a room that stopped sharing, or from a machine that said no, and only for a finding the room was sent |
| `refute`, `stale` | `id`, a time and the commit the checkout was at: a session checked a finding and found it false, or its lines have changed. Never why, or which lines |
| `told`, `use` | `id` and a time: a session was told a finding, and went on to act on it. Never which session or what it did |

Everything else observing keeps (the spool, its log of findings, what each session was told, a
ledger of runs and their cost) stays under `~/.agentmash/observe/`
(`hooks/observe.mjs:109 observePaths`). A session's start and its tool calls read the findings to
tell it from those files, with no request (`hooks/observe_recall.mjs:84 main`).

## Reports kept for later

A report to `POST /events` that got no answer, a 5xx, a 408 or a 429, or whose hook ran out of
time, is kept in `~/.agentmash/outbox/`: the event as it was made (the prompt excerpt and file
paths included), the checkout's folder and the server's address, without `diff` and without any
room key or token. At most 2,000 reports, 8 MB and 7 days. It is sent again, to the server its
checkout reports to then, by the next hook whose own report to that server arrived (up to 5 at a time) or by the
observing worker where that runs, with the same `report_id`, so the room stores it once, and `delayed_ms`, how long it
waited. No process exists only to retry, and nothing is sent again while `AGENTMASH_DISABLE` is on
(`hooks/lib.mjs:4175 reportEvent`, `:4423 keepReport`, `:4268 OUTBOX_LIMITS`, `:4625 sendHeld`,
`:4737 sendKeptAfterArrival`, `:4723 drainOutbox`).

## Text you or your agent write

These go when you or your agent send them, whatever `AGENTMASH_HINTS` says:

| What | Endpoint | Sends | Code |
| --- | --- | --- | --- |
| MCP `claim_work` | `POST /claims` | A task (up to 300 characters, secrets masked), repo-relative paths (up to 50), names (up to 100), a time to live, the branch, `until: merged` where the hooks looked at branches in the last day, your developer name and the session id | `hooks/mcp_server.mjs:1246 claim_work` |
| MCP `mark_resolved` | `POST /resolutions` | The file, an outcome, a pull request URL, a note (up to 500 characters), your developer name and the session id | `hooks/mcp_server.mjs:1404 mark_resolved` |
| MCP `reply_to_teammate` | `POST /api/v1/lobby/inbox` | A reply to a teammate's request (up to 4000 characters), their login, the request's id | `hooks/mcp_server.mjs:1552 reply_to_teammate` |
| MCP `task_create` | `POST /api/v1/lobby/spaces/:space/tasks` | A title (up to 400 characters), a description (up to 64,000), a status, a priority, a due day, labels (up to 10), who is on it, the room ref of one of the space's repositories | `hooks/mcp_server.mjs:1687 task_create` |
| MCP `task_update` | `PATCH /api/v1/lobby/spaces/:space/tasks/:task` | The fields the agent changes, as `task_create` sends them, and who to put on or take off the task | `hooks/mcp_server.mjs:1752 task_update` |
| MCP `task_comment` | `POST /api/v1/lobby/spaces/:space/tasks/:task/comments` | A comment (up to 8000 characters) | `hooks/mcp_server.mjs:1790 task_comment` |
| MCP `recall_observations` | `GET /observations?limit=5&file&about` | A repo-relative path and the subject the agent asks about (up to 200 characters, secrets masked), in the query string | `hooks/mcp_server.mjs:946 recallObservations` |
| `npx agentmash ask` | `POST /api/v1/lobby/inbox` | A request for a teammate's agent (up to 32,000 characters), their GitHub login, `--session` and `--ttl` when given | `cli/inbox.mjs:530 ask`, `:360 askBody` |
| Strict mode (`AGENTMASH_STRICT`) | `POST /events` | The reason your agent gave for going ahead, and the teammate's developer name, on its next edit report | `hooks/lib.mjs:3138 takeOverrideNote` |

Of these, only the `claim_work` task is masked on your machine.

## The MCP server

Your agent calls these tools. A call that gets past its own argument checks, and the server's
exit after a claim, first works out the room as the hooks do (`has_anyone_touched`, `claim_work`,
`release_claim` and `mark_resolved` before their paths are checked), which on a signed-in machine
with no room of its own can be the lookup above (`hooks/mcp_server.mjs:238 coordinationNow`).
All but the task tools ask the room through `hooks/mcp_coordination.mjs:141 requestJson`, with
the headers above.

| Tool | Endpoint | Sends |
| --- | --- | --- |
| `who_is_working_on_what`, `has_anyone_touched`, `list_contested_files` | `GET /activity?minutes&developer` | A time window, your developer name. A path you ask about is filtered on your machine, not sent (`hooks/mcp_server.mjs:314 activity`) |
| `claim_work` | `POST /claims` | See above |
| `release_claim` | `POST /claims/release`; with `paths`, `GET /claims?developer` first, then one release per claim wholly inside them | Developer, session id, a claim id or `all`. Paths are matched against your claims on your machine (`hooks/mcp_server.mjs:1306 release_claim`, `:346 releaseByPaths`) |
| (exit) | `POST /claims/release` | When stdin ends or the server is stopped, if it ever made a claim (even one released since): developer and each session id it claimed under (`hooks/mcp_server.mjs:2033 releaseOwnClaims`) |
| `list_claims` | `GET /claims?developer` | Developer |
| `get_collisions` | `GET /collisions?developer&minutes&advisory=1&memory=1` | Developer, a time window |
| `mark_resolved` | `POST /resolutions` | See above |
| `recall_observations` | `GET /observations?limit=5&file&about` | See above. Asked whether or not observing is on; where it is, this machine's own findings are added from its files |
| `check_inbox` | `GET /api/v1/lobby/inbox?box=in&state&limit=50`, and first `GET /api/v1/room` (with the room key and token) when the repository's config has no room ref | The sign-in and the room ref (`hooks/mcp_server.mjs:1494 check_inbox`, `:297 inboxAccess`) |
| `reply_to_teammate` | `GET /api/v1/me`, `GET /api/v1/lobby/inbox/:id`, then `POST /api/v1/lobby/inbox` (and `GET /api/v1/room` as for `check_inbox`) | The sign-in, the room ref, the id of the request it answers, and the reply (see above) |
| `tasks_list` | `GET /api/v1/lobby/spaces`, `GET /api/v1/lobby/spaces/:space/tasks` | The sign-in. The filters (status, assignee, label, words) are applied on your machine, not sent |
| `task_get` | `GET /api/v1/lobby/spaces`, `GET .../tasks?number=`, `GET .../tasks/:task` | The sign-in, the task's number |
| `task_create`, `task_update`, `task_comment` | `GET /api/v1/lobby/spaces`, `GET .../tasks?number=`, then the write | See above |

The task tools read and change the tasks of the space this repository's room is in. Their own
requests carry this machine's sign-in and none of the room's credentials
(`hooks/mcp_server.mjs:497 ask`). Each call first lists your spaces and picks the one holding
this room on your machine; like `check_inbox`, it first asks `GET /api/v1/room` when the
repository's config has no room ref (`hooks/mcp_server.mjs:566 taskPlace`). A task is found by
its number, and `task_create` asks for number 1 to see that the server takes agents' writes
(`:650 taskList`). Who is put on a task goes as a GitHub login (yours for `my_person`), or, for
`me`, the desktop app's session id and the room ref (`:626 whoRefs`). The MCP server holds an
agent to 60 task tool calls a minute, and to 20 new tasks and 120 changes or comments in 10
minutes (`:398 AGENT_TASK_LIMITS`). Where the desktop app gave the agent task tools of its own
(`AGENTMASH_LOBBY_TEAM_TOOLS=1`), these aren't listed and send nothing (`:1909 callTool`).

## CLI commands

A command that names a room and is turned away with `401 room_unauthorized` asks `GET /rooms/self`
once more, to say whether the key was rotated or the room deleted: `status`, `login --room`,
`rotate`, `revoke`, `disconnect`, `secure`, `reconcile`, `diffs`, `audit`, `purge`, `delete`
(`cli/agentmash.mjs:2976 keyTurnedAway`). Where `GET /rooms/self` answers 404 with no code (a
server older than it), `join`, `doctor` and `login --room` ask `GET /rooms/<room key>`, with the
key in the URL (`cli/agentmash.mjs:341 lookupRoom`).

| Command | Endpoints | Sends | Code |
| --- | --- | --- | --- |
| `npx agentmash` (no command), in a repository with a room ref | `GET /api/config`; when the server signs in with GitHub, `GET /rooms/self` | The room key (for `/rooms/self`), the sign-in beside it on its own server | `cli/agentmash.mjs:6369 main`, `:1636 serverSignsIn`, `:1547 connectedRepoOf` |
| `login` | `POST /auth/cli/start`, then `POST /auth/cli/token` every 2 seconds until you confirm in the browser; in a checkout whose config.json has a room, `GET /rooms/self` and, signed in to that room's server, `GET /api/lookup` for its GitHub remotes when the room's answer doesn't settle which repository it is | Your OS user name as a label, each GitHub remote's owner/name, the poll token; to the room, its key, its developer token where there is one, and the sign-in beside the key on its own server | `cli/agentmash.mjs:3627 signInMachine`, `:3599 waitForSignIn`, `:3486 cmdLoginMachine`, `:4803 roomSplit` |
| `login --room` | `GET /rooms/self` when config has no room ref; `POST /auth/cli/start` and `POST /auth/cli/token` polling, or `POST /rooms/tokens` (`--local`, or a server without GitHub sign-in) | Your developer name as a label (and `--developer`), the room key with the sign-in beside it, the poll token | `cli/agentmash.mjs:5339 cmdLogin`, `:5349 cmdLogin`, `:5360 cmdLogin`, `:5378 cmdLogin` |
| `logout` | `POST /api/logout` | The sign-in; `all` with `--all` | `cli/agentmash.mjs:3661 cmdLogout` |
| `init` | Signed in to this server: `GET /api/lookup` for each GitHub remote. Then GitHub (Third parties), `GET /api/config`, `POST /rooms`, `GET /healthz` twice, and, signed in, `POST /api/connect/room` and `POST /rooms/settings`; `GET /api/config` for the dashboard link when the new room has a ref, if not asked yet. In a repository already set up whose config.json has a room ref: `GET /api/config` and, when the server signs in with GitHub, `GET /rooms/self` | Each GitHub remote's owner/name and the sign-in, the room label, `allow_public_key` with `--allow-public-key`, the new room key, the one repository's owner/name, `sign_in_required`. In a repository already set up: its room key (for `/rooms/self`), the sign-in beside it on its own server | `cli/agentmash.mjs:1437 cmdInit`, `:1479 cmdInit`, `:1739 measuredBudget`, `:1659 connectNewRoom`, `:1700 askSignIn`, `:1505 cmdInit`, `:1390 cmdInit` |
| `join` | `GET /rooms/self`, GitHub, and `GET /api/config` when the room's answer gives a ref | The room key you give, to the host of a pasted link, with the sign-in beside it when that is its server | `cli/agentmash.mjs:1777 cmdJoin`, `:1794 cmdJoin` |
| `doctor`, in a set-up repository | Starts the command `.mcp.json` registers as `agentmash`, whatever it is (an `npx` entry asks the npm registry), from the root and from a subfolder, and lists its tools; `GET /healthz` twice, `GET /rooms/self`, `GET /activity?developer=`, and the `login` checkout check (`GET /api/lookup`) | Room key, token, sign-in, developer name (possibly your git email) in the query string, each GitHub remote's owner/name | `cli/agentmash.mjs:1849 mcpLaunchCommand`, `:2422 cmdDoctor`, `:2549 cmdDoctor`, `:2579 cmdDoctor`, `:2646 cmdDoctor`, `:2657 cmdDoctor` |
| `doctor`, signed in, no room here | `GET /healthz` twice, `GET /api/whoami`, `GET /api/lookup` | The sign-in, the repository's owner/name | `cli/agentmash.mjs:3931 doctorMachine`, `:3934 doctorMachine`, `:4024 doctorMachine` |
| `status`, in a set-up repository | `GET /activity`, `GET /rooms/self` and the checkout check (`GET /api/lookup`), then, for the dashboard link where the room's ref is known, `GET /api/config` and, when the server signs in with GitHub, `GET /rooms/self` | Room key, token, sign-in, each GitHub remote's owner/name | `cli/agentmash.mjs:2686 cmdStatus`, `:2695 cmdStatus`, `:2730 cmdStatus` |
| `status`, signed in, no room here | `GET /api/whoami`, `GET /api/lookup` | The sign-in, the repository's owner/name | `cli/agentmash.mjs:3858 statusMachine`, `:3873 statusMachine` |
| `git-hook` (install) | With no config.json and no `AGENTMASH_ROOM`, signed in: `GET /api/lookup` | The sign-in, the repository's owner/name | `cli/agentmash.mjs:2934 sayGitHookRoom` |
| `status`, `doctor`, `git-hook`, when the lookup says the repository isn't connected | GitHub (Third parties); `GET /api/config` when the answer names no page where an organization grants access | Nothing more | `cli/agentmash.mjs:5054 sayLookupMiss`, `:5119 grantLink` |
| `connect`, `disconnect` | `POST /api/connect/room` (up to 3 times a run), `POST /rooms/disconnect`. When the server wants GitHub to say again what you can push to, or refuses for want of push access, `connect` signs the machine in again (once a run) as `login` does, then sends `POST /api/logout` for the sign-in it replaced. On a refusal for want of push access: GitHub, and `GET /api/config` as above | `connect`: room key, sign-in, the repository's owner/name, `replace` with `--replace`; on a new sign-in, your OS user name as a label and the one repository it connects, and the replaced sign-in to end it. `disconnect`: room key, the room's developer token where there is one, the sign-in beside the key on its own server | `cli/agentmash.mjs:5168 cmdConnect`, `:5191 cmdConnect`, `:5195 cmdConnect`, `:5309 cmdDisconnect` |
| `rotate`, `revoke`, `secure`, `reconcile`, `diffs`, `audit`, `purge`, `delete` | `POST /rooms/rotate` (after GitHub), `/rooms/revoke`, `/rooms/tokens/revoke`, `/rooms/settings`, `/rooms/purge`; `GET /rooms/tokens`, `/rooms/self` (`reconcile` and `diffs` with no argument), `/audit`; `DELETE /rooms` | Room key, token, sign-in, the setting you chose, a developer name for `revoke --developer`, `grace_minutes` | `cli/agentmash.mjs:3008 cmdRotate`, `:3041 cmdRevoke`, `:3055 revokeDeveloper`, `:5418 cmdReconcile`, `:5428 cmdReconcile`, `:5449 cmdDiffs`, `:5458 cmdDiffs`, `:5494 cmdSecure`, `:5514 cmdSecure`, `:5547 cmdAudit`, `:5569 cmdPurge`, `:5579 cmdDelete` |
| `token create`, `list`, `revoke` | `POST`/`GET /api/v1/tokens`, `DELETE /api/v1/tokens/:id` (revoking by name lists first) | The sign-in; a token name, scopes, repositories, an expiry | `cli/token.mjs:279 create`, `:304 tokensOf`, `:353 revoke` |
| `ask`, `inbox` | `POST`/`GET /api/v1/lobby/inbox`, `GET /api/v1/lobby/inbox/:id`, its `accept`, `deny`, `cancel`; `GET /api/v1/me` when the sign-in keeps no login. To find the room first: `GET /api/lookup?repo=owner/name` in a checkout with no repository install, or `GET /api/v1/room` when the repository's config has no room ref | The sign-in, the room ref, the request (see above), a deny reason (up to 300 characters); for the lookup, the repository's owner/name; for `/api/v1/room`, the room key, token and sign-in | `cli/inbox.mjs:519 roomFor`, `:557 list`, `:623 show`, `:657 accept`, `:683 deny`, `:697 cancel`; `cli/agentmash.mjs:6226 inboxRoom`, `:6253 signedInRoom` |
| `digest` | With no room given or committed: `GET /api/lookup?repo=owner/name`. Then `GET /events?minutes&limit=1000` (paged, `--dry-run` too); `GET /rooms/self` or `/api/v1/room` when no label is known; with `--link` and a room key, `GET /rooms/self` and `GET /api/config` | Room key or ref, the sign-in where it goes (see Which server); for the lookup, the repository's owner/name | `cli/agentmash.mjs:6312 digestRoom`; `digest/src/net.mjs:88 fetchEvents`, `:111 fetchLabel`, `:136 fetchDashboardLink` |
| `scan` | The npm registry (Third parties) | | `cli/scan.mjs:64 scanCommand` |
| `hook <event>` | What the hooks send for that event (sections above), from `~/.agentmash/hooks/agent_hook.mjs` when it is there, else this package's | As the hooks | `cli/hook.mjs:228 runHook` |
| `mcp` | What the MCP server sends (above) | As the MCP server | `cli/agentmash.mjs:2030 cmdMcp` |
| `observe share on`, `off` | `POST /rooms/settings` | Room key, token, `share_observations` | `cli/agentmash.mjs:4586 observeShare` |
| `observe on`, `off`, `status`, `retry`, `log`, `forget`, `local` | none from the command. What observing sends once it is on is under [Observing](#observing); `forget` leaves a line the worker sends later | Nothing | `cli/agentmash.mjs:4699 cmdObserve` |
| `crew`, `team`, `tools`, `uninstall`, `version`, `help` | none | Nothing. The crew is bundled in the package | `cli/agentmash.mjs:5746 cmdCrew` |

## Third parties

- **GitHub's API** (`https://api.github.com`, or `AGENTMASH_GITHUB_API`). Before `init`, `join`
  or `rotate` commits a room key, the CLI asks whether each GitHub repository the checkout has a
  remote for (an SSH host alias named for GitHub included) is public: `GET /repos/{owner}/{name}`.
  When `connect` is refused for want of push access, and when `status`, `doctor` or `git-hook` find
  the repository isn't connected to a room, it can ask that and `GET /users/{owner}` (whether the
  owner is an organization). Unauthenticated, with the user agent `agentmash-cli`. Only owners and
  names are sent (`cli/visibility.mjs:32 repoVisibility`, `:76 isOrganization`; called from
  `cli/agentmash.mjs:1578 guardPublicKey`, `:4996 noPushAccess`, `:5068 sayLookupMiss`,
  `:5098 orgGrant`, `:5206 cmdConnect`).
- **The npm registry.** `npx agentmash scan` runs the separate `agentmash-scan` package through
  `npm exec --yes`, which asks npm's registry about it when it runs and downloads it the first
  time, unless a local copy is found or `AGENTMASH_SCAN_BIN` points at one
  (`cli/scan.mjs:64 scanCommand`). That package isn't in this repository. The MCP launcher runs
  `npx --yes --package agentmash@0.16.1` (or `AGENTMASH_MCP_PACKAGE`, any npm spec) only if you
  set `AGENTMASH_MCP_NPX=1` and no local copy loads (`hooks/mcp_launcher.mjs:63 PACKAGE_SPEC`,
  `:71 NPX_ENABLED`, `:246 serveViaNpx`). `doctor` starts whatever command `.mcp.json` registers
  as `agentmash`: the launcher, which can then do the same, or an `npx agentmash mcp` entry, which
  asks the registry whatever `AGENTMASH_MCP_NPX` says (`cli/agentmash.mjs:1849 mcpLaunchCommand`,
  `:2422 cmdDoctor`). npm's requests carry npm's own headers, its user agent among them (npm and
  Node versions, OS, CPU).
- **Slack, Telegram, or the URL you give.** `npx agentmash digest --to slack` or `--to telegram`
  (not with `--dry-run`) posts the digest to the webhook URL or Telegram bot you give it
  (`https://api.telegram.org/bot<token>/sendMessage` for a bare token): the room's label,
  developer names, branches, the busiest files and folders, who edited the same files, stalled branches
  and sessions, counts, and in a quiet period up to 5 recent files per person. Prompt text and
  commit subjects only with `--include-hints`. A dashboard link only with `--link`; that link contains
  the room key when the server doesn't sign in with GitHub, gives no room ref, or doesn't answer
  (`digest/src/net.mjs:149 postSlack`, `:169 postTelegram`, `:132 fetchDashboardLink`).
- **Your browser.** `login`, and `connect` when it signs in again, open the server's sign-in page;
  `init` and `join` open the dashboard link (by the room key where there is no ref to use) when
  run in a terminal outside CI. `--no-open` stops both (`cli/agentmash.mjs:3429 openBrowser`,
  `:1355 openInBrowser`).
- **Your `claude` command, when observing is on.** The observing worker runs `claude -p` under
  your own sign-in and hands it what [Observing](#observing) lists. Nothing of this happens
  until you run `npx agentmash observe on` (`hooks/observe_worker.mjs:428 runObserver`).
- **Other programs.** `tools` runs each agent's `--version`, and `login` and `tools add copilot`
  can run VS Code's `code --add-mcp` (`cli/agent-kit.mjs:112 versionOf`,
  `cli/agents/copilot.mjs:85 connect`). What those programs send is theirs.
- **Your git remote, in a partial clone.** The hooks and the MCP server run your own `git` in the
  checkout. In a partial clone (`--filter=tree:0`, say), git fetches objects it lacks from the
  checkout's remote, with your git setup, when a command needs them. The branch check at prompts
  can need them (`hooks/lib.mjs:7772 landedFiles`, `:7797 landedAt`, `:7945 ownerMergeCheck`,
  `:7996 mergedCheck`). So can a commit a room's answer names that the checkout lacks, when it
  is looked for in your history: before an edit, at a turn's end, at the prompt heads-up and in
  the MCP server's activity and collision tools (`hooks/lib.mjs:7020 inHistory`;
  `hooks/pre_tool_use.mjs:590 historyOf`, `hooks/stop.mjs:120 main`,
  `hooks/prompt_note.mjs:67 unmergedLines`, `hooks/mcp_server.mjs:335 historyOf`). These commands
  get none of your `GIT_*` variables but `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`,
  `GIT_CONFIG_NOSYSTEM` and any `GIT_TEST_*`, so `GIT_NO_LAZY_FETCH=1` doesn't reach them
  (`hooks/lib.mjs:6940 gitIn`).

## No telemetry

There is no analytics, crash reporting or usage ping anywhere in the client, and the package has
no runtime dependencies. A report that fails is written to a local log,
`~/.agentmash/log/reports.jsonl`, which `doctor` reads on your machine
(`hooks/lib.mjs:4077 logReportFailure`), and may be kept to send again
([Reports kept for later](#reports-kept-for-later)). The only version information the client's own requests
carry is the `x-agentmash-hooks` header.

## What stays on your machine

- File contents, beyond the identifier names above, unless your room streams diffs and you let it.
- The agent's replies and transcript, unless you turned observing on.
- `~/.agentmash/checkout-key`, `rooms.json` (a cache of room lookups), `told.json`, the
  failed-report log, `health/` (the count of unanswered checks) and each agent adapter's small
  state files. Of `outbox/`, a kept report leaves as the report it was; of `observe/`, only what
  [Observing](#observing) lists. Of `user.json`, the token leaves
  only as the headers above and the GitHub login only as your developer name; of
  `credentials.json`, only a room's developer token, as `x-agentmash-token`.
- Per-session scratch files under your temp folder, in `agentmash/`, and the list of reported
  commits in your checkout's `.git/`.
- Host names and folder paths, except as the keyed hash in `checkout_id`.
