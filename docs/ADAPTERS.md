# Seeing the rest of the team

AgentMash's ceiling is how much of a team it can see. A room that sees half a
team gives advice based on half the truth, and advice based on half the truth is
worse than none, because it reads as authoritative: the dashboard says a file is
free when it is not, and the advisory stays silent on the collision that actually
happens.

This page is the honest inventory of what can be seen today, and how.

Everything here was checked against primary documentation on **2026-10-04**.
Every row cites where. Nothing was written against an API that was not read
first — where a payload field is not documented, this page says so instead of
guessing.

The fifteen rows after GitHub Copilot were added on **2026-10-05**, each checked
that day against the tool's own documentation and, where it is open, its source
at a named release, and each section below says what is still to be seen in the
tool itself.

Past the documentation, each row's last column says how far it was checked: run
live in the tool itself, held by tests against payloads recorded from it, or
from its docs. The live runs so far: Claude Code, Codex (on codex-cli 0.160.0),
Cursor and the `cursor-agent` CLI, GitHub Copilot (the Copilot CLI on 1.0.91),
Kilo Code and OpenCode, each the warning before an edit and the reports.
The registry agentmash.dev/setup is drawn from says the same for each part of
each agent, and a test of the site holds this page's rows to it.

---

## 1. The matrix

| Tool | Extension point for a file edit | Verdict | Adapter |
| --- | --- | --- | --- |
| **Claude Code** | `PreToolUse` and `PostToolUse` hooks, matcher `Write\|Edit\|MultiEdit\|NotebookEdit`, and on `Bash` and `PowerShell`: before a command, the files its text says it writes; after it, the files the working tree says it changed | **Full** — path, prompt, session, before *and* after | shipped, [`hooks/`](../hooks/); run live |
| **Cursor** | `afterFileEdit` agent hook; `preToolUse` before an edit | **Full** — `file_path` + `edits[]` as first-class fields; the advisory as a refused first edit, since Cursor drops what a hook adds | shipped, [`clients/cursor/`](../clients/cursor/); run live, in Cursor and the `cursor-agent` CLI; its MCP tools held by tests against recorded payloads |
| **Devin** (formerly Windsurf) | Claude Code's own hooks, which it runs; its `write`, `edit` and `apply_patch` | **Full** — the path a field, or read out of the patch | shipped: the Claude Code hooks, [`hooks/`](../hooks/); from its docs and tests against recorded payloads |
| **Codex CLI** | `PreToolUse` and `PostToolUse` hooks, `tool_name: "apply_patch"` | **Full** — the path read out of the patch body (`filesInPatch`) | shipped at user level, [`hooks/`](../hooks/) with `--client codex`; run live on codex-cli 0.160.0 |
| **GitHub Copilot** | `PreToolUse` and `PostToolUse` hooks, in VS Code (preview) and the Copilot CLI | **Partial** — the hooks are a preview in VS Code, and Copilot sends no end of a session, so a session goes silent rather than ending | shipped at user level, [`hooks/`](../hooks/) with `--client copilot`; run live (the Copilot CLI on 1.0.91); its MCP tools held by tests against recorded payloads |
| **Amp** | a plugin, `~/.config/amp/plugins/agentmash.ts`: `tool.call`, `tool.result`, `agent.start`, `agent.end` | **Partial** — the files Amp names for a call; the advisory as a refused first edit (`reject-and-continue`), since a call it lets through takes no note; with its old permission rules on, it only reports | shipped at user level, [`clients/amp/`](../clients/amp/) running the generic hook with `--client amp`; held by tests against payloads recorded from its plugin API |
| **Antigravity** (CLI 1.2.7+, connected only when asked for) | `PostToolUse` and `PreInvocation` hooks in `~/.gemini/config/hooks.json` | **Partial** — the path a field after an edit; no warning before one, since a hook there that refused would stop every edit whenever it failed: a heads-up at the start of each turn instead | shipped at user level, the generic hook with `--client antigravity`, by `npx agentmash tools add antigravity`; from its docs, which our tests' payloads are written from |
| **Cline** (VS Code 4.1.11+, CLI 3.0.56+) | hook files `PreToolUse`, `PostToolUse` and `UserPromptSubmit` in `~/Documents/Cline/Hooks` | **Partial** — the path a field; the advisory arrives just after the edit, since Cline adds a hook's context once the tool has run, and nothing is ever cancelled; prompts in VS Code only | shipped at user level, the generic hook with `--client cline`; held by tests against recorded payloads |
| **Crush** (0.63+) | one `PreToolUse` hook in `~/.config/crush/crush.json`, matcher `^(edit\|multiedit\|write\|lsp_replace_symbol\|download)$` | **Partial** — the advisory as a refused first edit; an edit reported once its file changes, since Crush has no hook after a tool; no prompts, sessions or shell commands | shipped at user level, the generic hook with `--client crush`; held by tests against payloads recorded from its source |
| **Factory Droid** (0.202+) | `PreToolUse` and `PostToolUse` hooks in `~/.factory/hooks.json`, matcher `Create\|Edit\|ApplyPatch` | **Partial** — the path a field, or read out of the patch; the advisory as a refused first edit (`permissionDecision: deny`), since a call it lets through takes no note | shipped at user level, the generic hook with `--client droid`; from its docs and tests against recorded payloads |
| **Gemini CLI** (0.26+) | `BeforeTool` and `AfterTool` hooks in `~/.gemini/settings.json`, matcher `^(write_file\|replace)$` | **Partial** — the path a field; the advisory as a refused first edit, since `BeforeTool` cannot add context; it runs hooks only in folders it trusts | shipped at user level, the generic hook with `--client gemini`; held by tests against payloads recorded from its source (0.62.0) |
| **goose** (1.48+) | `PreToolUse` before its `write` and `edit` (a decision only), `AfterFileEdit` after one, from a plugin folder of ours | **Partial** — the path a field, with before and after for `edit`; the advisory as a refused first edit, since goose reads nothing but a decision before a tool | shipped at user level, the generic hook with `--client goose`; held by tests against payloads from goose 1.53.0's source |
| **Junie** (CLI 26.9.22+) | `PreToolUse` hook in `~/.junie/config.json`, matcher `Edit\|Write`; no hook after a tool | **Partial** — the advisory as context before the edit, from its docs, not yet seen live; an edit reported at the next edit or as the task ends; prompts in its terminal UI only | shipped at user level, the generic hook with `--client junie`; from its docs, and its reports by tests against recorded payloads |
| **Kilo Code** (7.0.28+: CLI, VS Code, JetBrains) | a plugin, `~/.config/kilo/agentmash.js`, named in Kilo's global config: `tool.execute.before` and `tool.execute.after` | **Partial** — the path a field, or read out of the patch; the advisory as a refused first edit, since a plugin cannot add a note to a call it lets through | shipped at user level, the plugin running the generic hook with `--client kilo`; run live, and held by tests against payloads recorded from its source (7.8.3) |
| **Kiro** (IDE 1.0.293+, kiro-cli --v3) | `PreToolUse` and `PostToolUse` command hooks in `~/.kiro/hooks/agentmash.json`, matcher `fs_write\|fs_append\|str_replace\|delete_file`; a refusal is exit 2 with the reason on stderr | **Partial** — the advisory as a refused first edit, since Kiro shows the model nothing a hook says before a tool otherwise; kiro-cli's default engine runs no such hooks | shipped at user level, the generic hook with `--client kiro --dialect kiro`; held by tests against payloads recorded from its docs and third-party captures |
| **OpenCode** (0.15+) | a plugin, `~/.config/opencode/plugin/agentmash.js`: `tool.execute.before` and `tool.execute.after`, `chat.message`, `event` | **Partial** — the path a field, or read out of the patch; the advisory as a refused first edit, since a plugin cannot add a note to a call it lets through | shipped at user level, the plugin running the generic hook with `--client opencode`; run live, and held by tests against payloads recorded from its source (1.18.34) |
| **OpenHands** (CLI 1.12+, Agent Canvas 1.24+) | `PreToolUse` and `PostToolUse` hooks in `~/.openhands/hooks.json`, and a plugin of ours for Agent Canvas | **Partial** — the path a field; the advisory as a refused first edit, since context added before a tool goes only to its event log | shipped at user level, the generic hook with `--client openhands`; held by tests against recorded payloads and its SDK's own hook code |
| **Qwen Code** (0.21.1+) | `PreToolUse` and `PostToolUse` hooks in `~/.qwen/settings.json`, matcher `^(edit\|write_file\|notebook_edit)$` (and `run_shell_command` after) | **Partial** — the advisory as a refused first edit, because `PreToolUse` runs after the person approved the edit and context added there never reaches the model; prompts from `submitted_prompt` | shipped at user level, the generic hook with `--client qwen`; held by tests against payloads recorded from its source (0.24.7) |
| **Continue** (config.yaml; cn 1.5+) | none: its CLI's hooks module is never called, and its extensions have none | **MCP only** — its agent asks the room through the MCP tools; no advisory before an edit, no report; its makers have stopped work on it (2.0.0 was the last release) | shipped at user level, the MCP server in `~/.continue/config.yaml`, only when that file exists; from its docs |
| **Zed** (0.214+) | none: its agent has no hooks | **MCP only** — its agent asks the room through the MCP tools; no advisory before an edit, no report | shipped at user level, the MCP server in `context_servers` in Zed's settings.json; from its docs |
| **Aider** | none | **No hook** — but `--auto-commits` is on by default, so the **git client covers it**, in each checkout that runs `npx agentmash git-hook install` | [`clients/git/`](../clients/git/) |
| **vim, Emacs, plain editors, anyone at all** | none | **Commit-time only** | [`clients/git/`](../clients/git/) |

`npx agentmash login` connects every one of them it finds at **user level**, in
each one's own settings in the home directory and never in a repository:
**Claude Code** (`~/.claude/settings.json`), **Codex** (`~/.codex/hooks.json`: the
Claude Code hooks with `--client codex`, the advisory before an `apply_patch` and a
report of each file in it, read by `filesInPatch`; its MCP server as an
`[mcp_servers.agentmash]` block in `config.toml`), **Cursor** (`~/.cursor/hooks.json`
and `~/.cursor/mcp.json`: the adapter below with `--global`, which at that level
also advises before an edit, by refusing the first edit of a file a teammate is in,
with the advisory as the reason, since Cursor drops a hook's `additional_context`),
**GitHub Copilot** in VS Code and its CLI (`~/.copilot/hooks/agentmash.json`, with
`--client copilot`; its MCP server in `~/.copilot/mcp-config.json`, and in VS Code by
`code --add-mcp`), and **Devin**, which runs the hooks in Claude Code's settings and
needs nothing of its own. Every agent in the matrix after GitHub Copilot is
connected the same way, in its own settings folder, with
[the generic hook](#the-generic-hook-one-script-a-dialect-each) and its MCP
server: **Amp** (`~/.config/amp`), **Cline** (`~/Documents/Cline/Hooks` and
`~/.cline`), **Crush** (`~/.config/crush/crush.json`), **Factory Droid**
(`~/.factory`), **Gemini CLI** (`~/.gemini/settings.json`), **goose**
(`~/.agents/plugins/agentmash`, a plugin folder of ours, goose's own `config.yaml`
untouched), **Junie** (`~/.junie`), **Kilo Code** (`~/.config/kilo`), **Kiro**
(`~/.kiro/hooks/agentmash.json` and `~/.kiro/settings/mcp.json`), **OpenCode**
(`~/.config/opencode`), **OpenHands** (`~/.openhands`) and **Qwen Code**
(`~/.qwen/settings.json`); **Antigravity** (`~/.gemini/config`) only when asked
for by name; and **Continue** and **Zed**, which run no hooks, their MCP server
alone. `cli/agents/<id>.mjs` is what each one writes (`cli/tools.mjs` reads them
all), `npx agentmash tools` shows where each stands on a machine, and `npx
agentmash logout` takes all of it back out. A repository can still commit Claude Code's hooks (`agentmash
init`) and the Cursor adapter (below), for teammates who never log in.

---

## 2. The evidence, tool by tool

### Cursor — full parity. This is the reference adapter.

Cursor's agent hooks are the closest thing to Claude Code's that exists: spawned
processes, JSON on stdin, JSON on stdout, per-hook `timeout`, exit 0 to proceed
and exit 2 to block, fail-open on any other exit code.

Config lives in `hooks.json`, merged from enterprise (`/etc/cursor/hooks.json`
and platform equivalents), team (cloud), project (`<root>/.cursor/hooks.json`)
and user (`~/.cursor/hooks.json`).

The documented events include `sessionStart`, `sessionEnd`, `preToolUse`,
`postToolUse`, `beforeShellExecution`, `beforeReadFile`, **`afterFileEdit`**,
`beforeSubmitPrompt`, `stop`, plus Tab hooks (`afterTabFileEdit`).

`afterFileEdit` delivers exactly what an AgentMash `edit` event needs:

```json
{ "hook_event_name": "afterFileEdit", "conversation_id": "…",
  "workspace_roots": ["/path/to/repo"], "file_path": "/abs/path/file.ts",
  "edits": [{ "old_string": "…", "new_string": "…" }],
  "user_email": "…", "cursor_version": "…" }
```

`edits` is shaped identically to Claude Code's `MultiEdit` tool input, so
`summarizeChange()` produces the same `+12/-3 lines, touching deletedAt` with no
new code. `beforeSubmitPrompt` carries `prompt`, which becomes the task hint.
`sessionEnd` carries `reason` and `duration_ms`.

> Source: [Hooks | Cursor Docs](https://cursor.com/docs/hooks), corroborated by
> [Cursor hooks.json: JSON Schema, Events & Payloads](https://ntorres.dev/blog/cursor-hooks-json-guide).

**Install** — `npx agentmash login` connects Cursor at user level, in
`~/.cursor/hooks.json` and `~/.cursor/mcp.json`. To commit the adapter into a
repository instead, put two files beside each other and add the config below.
`agentmash init` does not install the adapter, so it is not in `.claude/agentmash/`:
take it, and the `lib.mjs` it imports, from one version of the published package
(or from `clients/cursor/` and `hooks/` in a checkout of this repository):

```bash
npm pack agentmash
mkdir -p .cursor/hooks/agentmash
tar -xzf agentmash-*.tgz -C .cursor/hooks/agentmash --strip-components=2 package/hooks/lib.mjs
tar -xzf agentmash-*.tgz -C .cursor/hooks/agentmash --strip-components=3 package/clients/cursor/after_file_edit.mjs
rm agentmash-*.tgz
```

`.cursor/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "afterFileEdit":      [{ "command": "node .cursor/hooks/agentmash/after_file_edit.mjs", "timeout": 5 }],
    "beforeSubmitPrompt": [{ "command": "node .cursor/hooks/agentmash/after_file_edit.mjs", "timeout": 5 }],
    "sessionEnd":         [{ "command": "node .cursor/hooks/agentmash/after_file_edit.mjs", "timeout": 5 }]
  }
}
```

One script serves all three; it dispatches on `hook_event_name`. The room comes
from the same committed `.claude/agentmash/config.json` every other client reads,
so a Cursor user in a repo that already ran `agentmash init` needs no room id.

Cursor also runs Claude Code's hooks: its "third-party hooks" setting, on by
default, picks up `.claude/settings.json` and `~/.claude/settings.json`. Every
payload Cursor sends carries `cursor_version`, and the Claude Code hooks exit 0
at once, doing nothing, when they see it (`ranByCursor` in `hooks/lib.mjs`), so
a Cursor edit is reported once, by this adapter, and never a second time through
them.

**Before an edit, at user level.** Cursor drops what a hook adds to its agent's
context (`additional_context`), so a note beside the edit, the way Claude Code
takes one, never reaches the model. The user-level adapter (`--global`, the one
login installs) answers `preToolUse` on `Write` instead: it refuses the first edit
of a file a teammate is in, with the advisory as the `agent_message`, once per
conversation and file every ten minutes, and lets the agent's retry through. The
committed adapter above only reports. The `cursor-agent` CLI runs the same hooks
(seen live on 2026.10.01), and hands its agent a refusal's `user_message`, as the
tool's error, never its `agent_message`, so the adapter puts the advisory in both.

### Devin, formerly Windsurf (Cascade) — through Claude Code's hooks

Twelve hook events, including **`post_write_code`**, configured in
`.windsurf/hooks.json` (workspace), `~/.codeium/windsurf/hooks.json` (user), or
system paths. Exit 0 proceeds, exit 2 blocks (pre-hooks only). Payload:

```json
{ "agent_action_name": "post_write_code", "trajectory_id": "…",
  "execution_id": "…", "timestamp": "…", "model_name": "…",
  "tool_info": { "file_path": "…",
                 "edits": [{ "old_string": "…", "new_string": "…" }] } }
```

> Source: [Cascade Hooks](https://docs.windsurf.com/windsurf/cascade/hooks)
> (redirects to [docs.devin.ai/desktop/cascade/hooks](https://docs.devin.ai/desktop/cascade/hooks)).

Windsurf's agent is Devin now, and Devin's CLI reads Claude Code's hooks from
`.claude/settings.json` and `~/.claude/settings.json` by default
([Devin lifecycle hooks](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks)).
Its file tools are lowercase, `write`, `edit` and `apply_patch`, and the matcher
both installers write names them beside Claude Code's: Claude Code has no tools
by those names, and Devin reads a matcher as a regex. `write` and `edit` name
their file in `file_path` or `path`; `apply_patch` names its files only inside
its patch text (`*** Add File:`, `*** Update File:`, `*** Delete File:`,
`*** Move to:`), which `filesInPatch` in `hooks/lib.mjs` reads, so each file a
patch changes is checked before and reported after, on its own. Whether Devin's
agent reads the advisory a `PreToolUse` hook adds has not been confirmed yet.

A Cascade adapter of its own would have been the Cursor adapter with three
renames — `hook_event_name` → `agent_action_name`, `conversation_id` →
`trajectory_id`, `file_path` → `tool_info.file_path` — and one real gap: **there
is no `workspace_roots`**, so the repo root would have to come from the hook's
`working_directory` config or the process cwd. It is not needed: Devin runs
Claude Code's hooks.

### Codex CLI — built, the path read out of the patch

Codex has real hooks: `~/.codex/hooks.json`, `<repo>/.codex/hooks.json`, or
inline `[hooks]` tables in `config.toml`. Events include `PreToolUse`,
`PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `SessionStart`,
`SessionEnd`, `Stop`, `PreCompact`/`PostCompact`. Default command timeout 600 s.

`PostToolUse` does fire for file edits, with `tool_name: "apply_patch"` and a
payload of `session_id`, `cwd`, `hook_event_name`, `tool_use_id`, `tool_input`,
`tool_response`, `permission_mode`.

> Sources: [Hooks – Codex](https://developers.openai.com/codex/hooks) (redirects to
> [learn.chatgpt.com/docs/hooks](https://learn.chatgpt.com/docs/hooks)) and
> [Advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced).

**The blocker is honest and specific:** the edited paths live inside
`tool_input.command` as an `apply_patch` payload, not as a `file_path` field. An
adapter would have to parse Codex's patch envelope, and would silently stop
reporting the day that format changed — the worst failure mode there is, because
the room would look healthy while going blind. That parser is a day of work plus
a compatibility test against real Codex output, and it should not be written from
documentation alone.

**Since built, at user level.** The parser is `filesInPatch` in `hooks/lib.mjs`,
with tests of its own (`hooks/test/patch.test.mjs`) and a run against Codex
0.160.0 itself. The payload, as Codex's own schemas give it
(`codex-rs/hooks/schema/generated`): `tool_input` is `{ "command": "<the
patch>" }` for `apply_patch`, and the shell tool is `Bash`. Codex runs a hook only
once the person approves it in `/hooks`, keyed to a hash of the hook's
definition (its event, matcher, command and timeout) at its place in
`hooks.json`, which is why login's commands never change between versions and
why it never moves its groups. Run live on 2026-10-04 against codex-cli 0.160.0:
the advisory before an `apply_patch` reached the model, edits and prompts reached
the room, and the MCP tools answered.

Note also what is *not* sufficient: `notify`, which carries `thread-id`,
`turn-id`, `cwd` and `last-assistant-message` — no file information at all. (That
it fires *only* on `agent-turn-complete` comes from the advanced-configuration
page rather than the hooks reference above, and is the one claim on this page not
re-checked against a primary source.)

### GitHub Copilot — built, in VS Code and its CLI

Two separate hook systems, both real:

- **Copilot CLI and the Copilot cloud agent.** Config in `.github/hooks/*.json`
  (repo), `~/.copilot/hooks/` (user), or an inline `hooks` block in
  `.github/copilot/settings.json`. Events include `sessionStart`, `sessionEnd`,
  `userPromptSubmitted`, `preToolUse`, **`postToolUse`**, `postToolUseFailure`,
  `agentStop`, `permissionRequest` (both camelCase and PascalCase accepted).
  `postToolUse` carries `toolName`, `toolArgs` and `toolResult`.
  The reference covers the VS Code extension too, via the PascalCase variant —
  what is separate is the *preview* hook surface below, not the whole editor.
  > Source: [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference).
- **VS Code agent hooks**, a separate preview feature: `.github/hooks/*.json`,
  events `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `PreCompact`, `SubagentStart`, `SubagentStop`, `Stop`; stdin carries
  `timestamp`, `cwd`, `session_id`, `hook_event_name`, `transcript_path`, plus
  `tool_name` and `tool_input`. Gated behind `chat.useCustomAgentHooks: true`,
  and documented as "currently in Preview. The configuration format and
  behavior might change."
  > Source: [Agent hooks in Visual Studio Code (Preview)](https://code.visualstudio.com/docs/agent-customization/hooks).

**The gap:** neither reference enumerates the keys inside `toolArgs` /
`tool_input` for the edit tools, so the path key is unknown. That is one
30-second empirical check against a live install away from an adapter — but it is
a check, not a guess, and the live run below is where the CLI's keys came from.

**Since built, at user level, and run live.** Login writes
`~/.copilot/hooks/agentmash.json` in the format both read (PascalCase events,
flat entries, no `version`; VS Code reads `timeout`, the CLI `timeoutSec`). The
edit tools' path keys handled are the ones field reports give: VS Code's
`create_file`, `replace_string_in_file`, `multi_replace_string_in_file`,
`insert_edit_into_file` (`filePath`, or `files[]`, `replacements[].filePath`) and
`apply_patch` (`input`), and the CLI's `create` and `edit` (`path`; the CLI 1.0.91
names them `Create` and `Edit`, with `path`, `old_str`, `new_str` and `file_text`,
and sends an `apply_patch` edit as an `Edit` whose input is the bare patch). VS Code
runs every hook for every tool whatever a matcher says, so the scripts sort the tools
themselves. VS Code runs them while `chat.useHooks` is on, its default. Run live on
2026-10-05: the Copilot CLI 1.0.91 hands its agent the advisory a `preToolUse` hook
adds, as VS Code's agent takes it, and reports every edit. Copilot sends no
event when a session ends, so a Copilot session goes silent on the board rather
than ending.

**A known edge: VS Code with `chat.useClaudeHooks` on.** That setting, off by
default, has VS Code run the hooks in `~/.claude/settings.json` as well as
`~/.copilot/hooks/agentmash.json`, and then a Copilot edit is reported twice:
once as Claude Code's (`tool` "replace_string_in_file", say) and once as
Copilot's ("copilot:replace_string_in_file"). A patch through VS Code's
`apply_patch` shows in that first copy as Devin's ("devin:apply_patch"), since
Devin's patch tool goes by the same name. Cursor's twin of this is guarded
(`ranByCursor`: every Cursor payload carries `cursor_version`), but VS Code's
payload carries nothing that tells it from Claude Code's: its common fields are
`timestamp`, `cwd`, `session_id`, `hook_event_name` and `transcript_path`, and
no environment variable is documented for a hook. `timestamp` is the one field
Claude Code does not send today, and a guard on it would silence every Claude
Code hook the day Claude Code adds one, so there is none. With
`chat.useClaudeHooks` on, leave Copilot out (`npx agentmash tools remove
copilot`), or leave the setting off.

**And the Copilot CLI, if it runs Claude Code's hooks too.** It is said to load
`~/.claude/settings.json` beside its own hooks, which would report each of its edits twice,
once as Claude Code's. Its own payload format is camelCase (`sessionId`, `toolName`,
`toolArgs`) and Claude Code always sends `session_id`, so a Claude Code hook run with no
`--client` on a payload with `sessionId` or `toolArgs` and no `session_id` ends at once, doing
nothing, while `~/.copilot/hooks/agentmash.json` is there to report it (`ranByCopilotCli` in
`hooks/lib.mjs`). Without that file, they report it as they always did. The shape comes from the
Copilot CLI's hooks reference: one session of the CLI with Claude Code's hooks loaded is still to
confirm it.

### The generic hook: one script, a dialect each

Every agent after GitHub Copilot in the matrix runs one script, `hooks/agent_hook.mjs`,
with `--client <its id>`. It reads what the agent sends, hands it, shaped as Claude
Code would have sent it, to the script Claude Code runs at the same moment, and says
that script's answer in the agent's own format: a **dialect**, one file each in
`hooks/dialects/`. So the advice and its wording, strict mode, claims, symbols, the
looks at the working tree and the room a checkout reports to are the Claude Code
hooks' own, and an agent added later changes none of them. A report is handed off in
the background and the hook returns at once; a check before an edit costs one more
node start, a few tens of milliseconds, on top of the 1500 ms budget.

What decides a connector is what the agent does with a hook's answer before a tool
runs, and for most of them it is one thing: they let a tool run or refuse it, with a
reason the model reads, and have no way to add a note to a call they let through.
For those, the advisory goes as a refusal of the first edit of a file a teammate is
in, with the advisory as the reason, once per session and file every ten minutes, and
the same edit again goes through (`dialects/deny-once.mjs`, which Cursor's adapter
does its own way). A refusal is made only once it is written down, so a sandbox that
cannot write the home folder never refuses every try. Nothing a dialect says ever
approves what the person would otherwise be asked about: where "allow" could skip a
person's approval, the dialect says nothing instead.

A tool agentmash has no connector for can register the same script:
`npx agentmash hook --print-command` prints the line, and
[docs/API.md](API.md#your-own-tools-hooks-the-generic-hook) is its contract.

### Amp — a plugin of ours

Amp has no command hooks; it loads plugins. Login writes one,
`~/.config/amp/plugins/agentmash.ts` (`$XDG_CONFIG_HOME/amp/plugins`), self-contained,
and its MCP server into `amp.mcpServers` in Amp's `settings.json`, edited as text so the
person's comments and layout come back byte for byte. The plugin decides nothing: it
hands each `tool.call`, `tool.result`, `agent.start` and `agent.end` to the generic
hook with the files Amp's own helpers name, and kills it on its own timer. A
`tool.call` can only allow or refuse, so the advisory is a refused first edit, Amp's
documented `reject-and-continue`. When the person's settings turn on Amp's older
permission rules, the plugin registers no `tool.call` handler and only reports, since
how two plugins' answers combine is not documented. Threads in orbs load no machine's
plugins, and are not seen. Not yet confirmed live: that the edit tools fire
`tool.call`, and that the reason reaches the model.

### Antigravity — a heads-up each turn, when asked for

Antigravity's CLI, app and IDE share `~/.gemini/config/hooks.json`. Its `PreToolUse`
fails closed: a hook that crashes, times out or prints `{}` refuses the tool, and its
documented "allow" approves the tool outright. A connector there would stop every
edit the day node went missing from a GUI app's `PATH`, so there is none before an
edit. Login registers `PostToolUse` for the edit tools and the shell, and
`PreInvocation`, whose `injectSteps` puts a heads-up in front of the model at the
start of each turn: who is at work on the branch, or in its files. Prompts are read
from the turn's transcript, a format Antigravity does not document. Because nobody has
recorded what Antigravity does when one of these hooks fails to start, it is connected
only when asked for by name, `npx agentmash tools add antigravity`, and a plain login
leaves it out until then.

### Cline — told just after the edit

Cline's hooks are executable files named after their events, in
`~/Documents/Cline/Hooks`, the one folder both the VS Code extension and the CLI read;
login writes three of its own there (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`)
and its MCP server into `~/.cline/data/settings/cline_mcp_settings.json`, under Cline's
own lock. Cline adds a hook's `contextModification` after the turn's tool calls have
run, and `cancel` stops the whole task and tells the person, not the model, so the
advisory is said honestly late: just after the edit, for the agent's next step, and
nothing is ever cancelled. The CLI sends no hook for a typed prompt, so prompts are
reported from VS Code only, and no hook at a session's end. On Windows Cline runs only
PowerShell hooks, untested here, so login adds the MCP server alone there.

### Crush — one hook, and a watch on the file

Crush has a single hook event, `PreToolUse`, and adds a hook's `context` to the tool's
result after it has run. So the advisory is a refused first edit, in Crush's native
`{"decision":"deny"}`, and never `allow`, which in Crush approves the call. With no
hook after a tool, a call it lets through is fingerprinted before it runs and watched
by a detached process until the file changes: then, and only then, it is reported, so
a failed or declined edit never is. Prompts, sessions and shell commands are not
seen. Login writes `~/.config/crush/crush.json` (`CRUSH_GLOBAL_CONFIG`), strict JSON,
in the file's own layout.

### Factory Droid — refused once, with the reason

Login writes a bare event map to `~/.factory/hooks.json` and the MCP server to
`~/.factory/mcp.json`. When there was no `hooks.json`, Droid read hooks from
`settings.json`, which a new file would hide, so the new one starts with a copy of
those, and `settings.json` is never written. The advisory is a refused first edit as
JSON `permissionDecision: "deny"`, which Factory documents as sending the reason to
the model; a `Stop` hook tells the person at the keyboard about a collision as the
session finishes. Droid can import Claude Code's hooks: login replaces an import in
its own file, and the Claude Code hooks say nothing when Droid's payload shows one of
its autonomy levels (`ranByDroid` in `hooks/lib.mjs`), so its work is not reported
twice, once as Claude Code's.

### Gemini CLI — refused once, in trusted folders

Login adds `BeforeTool`, `AfterTool`, `BeforeAgent`, `SessionStart` and `SessionEnd`
hooks, each named `agentmash-*`, and the MCP server to `~/.gemini/settings.json`
(`$GEMINI_CLI_HOME`), after the person's own, with no `trust` on the server. Read in
its 0.62.0 source: `BeforeTool` cannot add context, and a deny reaches the model as
"Tool execution blocked: <reason>" while the turn goes on, so the advisory is a
refused first edit. `BeforeAgent` and `SessionStart` take `additionalContext`, which
carries the heads-up. Gemini CLI runs hooks and MCP servers only in folders the person
trusts, and a settings file with comments is left alone, since writing it back would
lose them. The command runs node by its full path with its error output discarded, so
a missing node is a warning in Gemini CLI, never a refusal.

### goose — a plugin folder of ours

goose finds plugin folders under `~/.agents/plugins` with no approval, so login writes
one, `~/.agents/plugins/agentmash`, with `hooks/hooks.json` and `.mcp.json`, and never
touches goose's own `config.yaml`, which goose rewrites whole. `PreToolUse` reads
nothing but a decision, so the advisory is a refused first edit; goose adds "Do not
retry" to every refusal, and the reason says that for this first hold the same edit
goes through. `AfterFileEdit` reports with the text before and after, and the shell is
seen through the working tree. goose Desktop and `goose acp` send no session end, and
goose's subagents run no hooks.

### Junie — advised before the edit, reported a step later

Junie's docs say `PreToolUse` `additionalContext` reaches the model for that step
without blocking, so Junie gets the advisory as Claude Code does, beside the edit;
nobody has seen it arrive live yet. Junie has no hook after a tool, so each `Edit` and
`Write` is written down before it runs and reported when its file has changed, at the
agent's next edit or as the task ends. Junie's working folder is `~/.junie`, never the
project, so the project comes from the payload's `project_path`, the session's own
start, or the file's checkout. Login writes `~/.junie/config.json` and
`~/.junie/mcp/mcp.json` (`$JUNIE_HOME`); Junie in the IDE runs no hooks.

### Kilo Code — a plugin, named in its config

Kilo Code's CLI, VS Code extension and JetBrains plugin share one backend, which loads
JavaScript plugins. Login writes `~/.config/kilo/agentmash.js` and names it with a
`file://` entry in Kilo's global config, beside its MCP server, rather than putting it
in a `plugin/` folder, which would have Kilo install a package before it loads any
plugin at all. A plugin's `tool.execute.before` cannot add a note to a call it lets
through, but a throw there reaches the model as the tool's error and the turn goes on,
so the advisory is a refused first edit. With `KILO_PURE=1` Kilo loads no plugins.

### Kiro — exit 2, with the reason

Kiro reads hooks from `~/.kiro/hooks/*.json`; login writes a file of its own,
`agentmash.json`, with `PreToolUse`, `PostToolUse` and `UserPromptSubmit`, and the MCP
server to `~/.kiro/settings/mcp.json` (`$KIRO_HOME/settings`). Before a tool Kiro shows
the model nothing a hook prints unless the hook refuses, which is exit 2 with the reason
on stderr, so the advisory is a refused first edit said that way; exit 0 with no output
grants nothing, and Kiro's own approval still follows. The Kiro IDE runs these hooks;
kiro-cli runs them on its V3 engine (`kiro-cli --v3`), not its default one. Not yet
confirmed live: that Kiro reads the matcher as a regular expression.

### OpenCode — a plugin of ours

Login writes `~/.config/opencode/plugin/agentmash.js` (the singular `plugin/`, which
every OpenCode release reads), a plugin that does no work in OpenCode's process: it
hands each edit, write and `apply_patch` to the generic hook and waits at most five
seconds. What `tool.execute.before` returns is ignored and a throw reaches the model as
the tool's error, so the advisory is a refused first edit; OpenCode's own permission
rules stay in charge of everything else. A subagent's edits are reported under its
lead's session. The MCP server goes into OpenCode's global config, edited as text so
comments and trailing commas survive. `opencode --pure` runs no plugins.

### OpenHands — refused once, in the CLI and Agent Canvas

The OpenHands CLI reads `~/.openhands/hooks.json`, and Agent Canvas reads plugins, so
login writes both, each where its product is found: the hooks and `mcp.json` for the
CLI, and a plugin of its own, `~/.openhands/plugins/agentmash-openhands`, for Agent
Canvas. In both SDKs, context added before a tool goes only to the event log, and a
deny reaches the model as "Action rejected: <reason>", so the advisory is a refused
first edit; anything else is said as nothing at all. Checked against the SDK's own
hook configuration and executor code at the CLI's release and at 1.51.0. The CLI is no
longer maintained; Agent Canvas runs the plugin on its local agent server, not in
Docker.

### Qwen Code — refused once, after the approval

Qwen Code took Claude Code's hook contract, so login writes `PreToolUse`,
`PostToolUse`, `UserPromptSubmit`, `SessionStart` and `SessionEnd` hooks and the MCP
server to `~/.qwen/settings.json` (`$QWEN_HOME`). Its `PreToolUse` runs after the person
has approved the edit, and context added there never reaches the model in 0.24.7, so
the advisory is a refused first edit, as `hookSpecificOutput.permissionDecision`, which
no other hook's "allow" overrides; in its default mode the person approves the retried
edit a second time. Prompts are reported from `submitted_prompt`, from 0.21.1, so a
continuation after a tool call is never taken for one.

### Continue and Zed — the MCP tools only

Neither runs hooks: Zed's agent has none (checked in its source at 1.22), and
Continue's CLI has a hooks module nothing calls. Login gives each the MCP server
alone, Zed in `context_servers` in its `settings.json`, Continue in
`~/.continue/config.yaml` when that file exists, so the agent hears about teammates
when it asks, and its edits do not show in the room. Each asks the person before every
MCP tool call, and login approves none. Their commits reach the room through
[the git client](#3-the-git-client), and Zed's Claude Code threads run Claude Code's
own hooks.

### Aider — no hook, and it does not need one

Aider has no event or plugin system. What it has is command hooks for a different
purpose:

- `--lint-cmd` (with `--auto-lint`, **default on**) runs after changes, and "the
  lint command should accept the filenames of the files to lint" — so it does
  receive the edited paths.
- `--test-cmd` / `--auto-test` (default off), same idea.
- `--auto-commits`, **default on**: aider commits every change set it makes.

> Sources: [Options reference | aider](https://aider.chat/docs/config/options.html),
> [Linting and testing | aider](https://aider.chat/docs/usage/lint-test.html).

Two conclusions, and the second is the useful one.

A `--lint-cmd` shim would technically work, and it is a bad idea: it occupies a
slot a team probably wants for an actual linter, runs synchronously inside
aider's edit loop (so a slow server costs the user real time, against the whole
reliability contract), and gets no prompt to use as a task hint.

**But aider auto-commits by default**, so the [git client](#3-the-git-client)
already sees aider users — and sees them *well*, because aider commits per change
set rather than once a day. For aider, commit-time reporting is close to
edit-time reporting. No adapter needed: `npx agentmash git-hook install` in each
checkout, which `npx agentmash login` does not do for you.

---

## 3. The git client

The lowest-effort way to see the invisible half of a team is the commit itself.
`.git/hooks/post-commit` fires for **everyone**: Cursor without the adapter,
vim, Emacs, a JetBrains IDE, `git commit` from a script, a person who has never
run an agent in their life.

```bash
npx agentmash git-hook install     # each developer, once, per checkout
```

It is installed by default by `agentmash init` and `agentmash join`; pass
`--no-git-hook` to skip it. **Argument for default-on:** `.git/hooks` is not
committed, so it cannot surprise a teammate; it cannot affect a commit (see
below); `agentmash uninstall` removes it and restores whatever it replaced; and
the people it exists for are exactly the people who will never discover an opt-in
flag. **`init` is also non-interactive by design** — it runs in CI and behind the
one-click web installer — so a prompt was not an option and a flag is the honest
alternative.

`npx agentmash login` does not install it: `.git/hooks` belongs to one checkout,
and the login writes into no repository. The worker reports to the room the
repository carries, in the `.claude/agentmash/config.json` that init commits. A
repository connected on the website carries none: there, on a machine signed in
with `npx agentmash login`, it reports to the room the repository is connected
to, looked up under that sign-in as the login's hooks look it up, and never in
place of a room the repository carries. With neither, it reports nothing, and
`git-hook install` says so.

### Where "not committed" stops being true: `core.hooksPath`

That whole argument rests on the hooks directory being local. `core.hooksPath`
can move it into the working tree — `.githooks/`, `.husky/_`, lefthook — and
there, installing writes a **tracked file** and an untracked `post-commit.local`
beside it. The next `git add -A` commits AgentMash onto everyone who pulls, which
is the exact surprise the default-on argument promises cannot happen.

So when the resolved hooks directory is inside the working tree, **the installer
refuses and says why**, and `agentmash init` finishes the rest of the install
without it. `--force-hooks-path` overrides.

The other way it stops being true is a `core.hooksPath` set in the **global or
system** git config, a `~/.githooks` every repository on the machine runs its
hooks from. Installing there used to move the owner's own `post-commit` aside and
put the shim in front of it for every repository, say only "installed alongside
the one already there", and let an `uninstall` in any one repository take it out
of all of them. So the installer refuses that too, naming the folder and the
config that set it. `--force-hooks-path` opts in, and the repository that did
notes it in its own git directory (`.git/agentmash-shared-hook.json`, never
committed): only an uninstall there takes the hook out again, and one anywhere
else leaves it. A `core.hooksPath` in a repository's own config is that
repository's choice, and installs as before.

Refusing rather than quietly installing into `.git/hooks` instead is deliberate:
when `core.hooksPath` is set, git runs hooks from there and **nowhere else**, so
a hook written to `.git/hooks` would never run. The choice is between a visible
refusal and an invisible no-op that `doctor` would report as installed.

Two more things worth knowing before you reach for `--force-hooks-path`:

- **Hook managers regenerate their directory.** husky rewrites `.husky/_` on
  `npm install`, lefthook on `lefthook install`. The shim is deleted, the hook it
  moved aside stays stranded in `post-commit.local`, and the next install refuses
  because that file already exists. If your team manages hooks with a tool, add
  the one line to *its* config instead of installing over it.
- Under a hook manager, `agentmash doctor` names the situation rather than
  claiming the client is installed.

Because `.git/hooks` is local and uncommitted, a teammate who only runs
`git pull` gets the Claude Code hooks but **not** this one. `agentmash doctor`
says so explicitly, which is the discovery path.

### It cannot slow down or break your git

The installed `post-commit` is about fifty lines of `/bin/sh`, of which the
load-bearing one is `node "$worker" "$root" "$sha" "$ref" </dev/null >/dev/null 2>&1 &`: the
worker is backgrounded (with `&` — it is not `setsid`-detached) and every one of
its streams is closed off, so git has nothing to wait on and nothing to print.
Then `exit 0`. That is the git equivalent of the reporting hooks' `async: true`,
and it is why the budget discipline in
[PROTOCOL.md §6](../PROTOCOL.md#6-what-a-client-must-do-on-failure) is belt to
that braces rather than the only protection. Tested against a server that is
down, a server that hangs for 30 seconds, and a server that merely answers
slowly: the commit completes in under three seconds in every case, mentions
nothing, and the worker exits 0 silently. Measured against a 50 ms server, a
commit takes ~80 ms with the hook installed, indistinguishable from the same
commit before the hook's last change.

The hook hands the worker the commit it ran for and the branch it was made on,
from the one `git rev-parse` it already ran for the checkout's top. The worker
starts in the background, and by the time it looks, a second commit or a checkout
may have moved HEAD on.

If the worker is not installed, the hook is inert. If `node` is not on `PATH`,
the shim checks where the common version managers put it (volta, Homebrew,
`/usr/local`, nvm) before giving up — hooks run under a non-login shell that
never reads your profile, so a GUI git client's `PATH` has none of them. All of
that is `[ -x ... ]` on a glob: no subprocess, no measurable cost. If it still
finds nothing, it does nothing, silently, and `agentmash doctor` says so.

### It coexists with a hook you already have

If a `post-commit` hook is already there, it is moved to `post-commit.local` and
**runs first, unchanged** — same file, same mode, same output, same arguments.
`agentmash git-hook uninstall` (and `agentmash uninstall`) moves it back.
A `post-commit` that is not ours is never deleted, and re-running install never
chains the hook to itself. All four of those are tested against real repositories
with real commits.

### What it sees

| | Editor hook | Git post-commit |
| --- | --- | --- |
| Which files | every write, as it happens | only what landed in a commit |
| When | seconds after the edit | at commit time — minutes to days later |
| Intent | the user's actual prompt | the commit subject |
| Change detail | `+12/-3 lines, touching deletedAt` | `commit a1b2c3d · +12/-3 lines` |
| Work in progress | **yes** | **no** |
| Warns *before* an edit | **yes** | **no** |
| Uncommitted, unstaged, stashed work | visible | invisible |
| Branches nobody has committed to | visible | invisible |
| Merge commits | n/a | deliberately skipped — but see the squash-merge gap below |
| Coverage | only the agents whose hooks login connects | **everyone** |

### The honest limit

**`git merge --squash` is not skipped, and claims the whole branch.** The merge
guard is "more than one parent", which is exactly right for `git merge --no-ff`.
A squash merge produces a *single-parent* commit carrying the entire branch diff,
so it goes through and reports the squasher as having touched every file on the
branch. There is no signal left to detect it with: `MERGE_HEAD` and `SQUASH_MSG`
are both gone by the time `post-commit` runs (verified, not assumed — there is a
test that asserts it). Guessing from the subject line would suppress real work
for a string match, so it is documented instead of guessed. What survives is the
truncation note: a squash of more than 50 files is reported as 50 files with
"*N files in this commit*" attached, so a reader can see what happened.

**Rewritten history is deduplicated by tree, not by sha.** `git commit --amend`
mints a new sha for work already in the room, so the client remembers the tree
hash as well: an amend that only rewords is silently skipped, an amend that
changes content is reported as the new work it is. The cost is that a commit
which reproduces an earlier tree exactly — a revert of a revert — goes
unreported. Amends are hourly; revert-of-a-revert is not.

**Windows is tested by hand, not in CI.** The shim is `#!/bin/sh`, which Git for
Windows runs under its bundled Git Bash, and the install path avoids the two
things that actually break there (`chmodSync` is close to a no-op, and the
installer never renames a file it has open). `clients/test/git_hook.test.mjs`
passes on a Windows checkout with Git for Windows, real commits through the shim
included; the tests that need POSIX file modes, symlinks or a POSIX `PATH`
layout skip there. CI runs on Linux only, so a change can still break Windows
without a red run. The failure mode if it does is the safe one — an inert hook,
reported as inert by `agentmash doctor`.

**Commit-time visibility is retrospective, and the collisions AgentMash exists to
warn about happen before the commit.** By the time a `post-commit` event lands, the
other person's afternoon of work is already written; a teammate's agent that gets
warned about it is being told about a collision, not saved from one. Someone who
commits once a day is invisible for a day. Someone who never commits is invisible
forever.

What it genuinely delivers, and this is not nothing:

- The dashboard stops lying by omission. "Nobody is in this file" becomes true.
- Hot files — the same file touched by two or more people — become detectable
  across a whole team rather than across the Claude Code half of it, over hours
  rather than minutes.
- An agent about to edit a file gets told a human landed changes there 20 minutes
  ago, with the commit subject explaining why. That is exactly the context that
  stops it from reverting someone's work.
- Aider users get near-edit-time coverage for free, because aider auto-commits.

One rough edge worth naming: the advisory a Claude Code agent receives is worded
"*<name>'s agent modified …*", which is not quite right when the touch came from
a human's commit. The `change_summary` says `commit a1b2c3d · +12/-3 lines`, so
the reading agent has the truth in front of it, but the sentence around it is
inherited from a time when every client was an agent. Fixing the wording means
carrying provenance through `GET /check`'s holder shape, which is a schema change
in the store rather than a change to this client.

It turns "we see nothing about this person" into "we see where they landed". It
does not turn it into "we see what they are doing", and no amount of engineering
on a git hook will.

---

## 4. Writing your own

[PROTOCOL.md](../PROTOCOL.md) is the whole contract, and
[§9](../PROTOCOL.md#9-conformance-checklist) is the checklist. The short version:

- Resolve the room from `.claude/agentmash/config.json`, honour `AGENTMASH_DISABLE`.
- `POST /events` with `x-agentmash-room`, one event per file touched.
- Repo-relative forward-slash paths, `tool` set to something that names your client.
- Hard timeout, no retries, exit 0 and say nothing — whatever happens.

A tool with real hooks needs no client of its own any more: register
[the generic hook](#the-generic-hook-one-script-a-dialect-each), in the dialect it
reads (`npx agentmash hook --print-command --client <id> --event <event>`), or add a
dialect for it in `hooks/dialects/`. A tool that talks HTTP has the public API,
`/api/v1`, with personal tokens and the advice already worded:
[docs/API.md](API.md). For an agent agentmash should connect by itself, a module in
`cli/agents/` is the whole connector: login, `tools`, doctor and logout pick it up
from the folder. `hooks/test/fixtures.mjs` and `cli/test/fixtures/machine.mjs` are the
intended starting point for proving it behaves.
