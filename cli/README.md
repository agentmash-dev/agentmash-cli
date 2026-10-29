# agentmash

agentmash (AgentMash) is one app for your team’s AI coding agents: Claude Code, Codex, Cursor
and more on your own logins, each told which files a teammate’s agent is changing.

When several people run agents against the same repository, their edits collide: two agents edit
the same file, one breaks the interface the other is building against, both write the same helper.
agentmash reports every edit to a small coordination server, and before an agent edits a file a
teammate's agent just changed, it is told who changed it, when and what. It works through each
agent's own hooks and an MCP server: no fork, no wrapper. `npx agentmash login` connects every agent
it finds on the machine: Claude Code, Codex, Cursor, GitHub Copilot, Devin, Amp, Cline, Crush,
Factory Droid, Gemini CLI, goose, Junie, Kilo Code, Kiro, OpenCode, OpenHands and Qwen Code, with
Antigravity when you ask for it, and the MCP server alone for Continue and Zed, which have no
hooks. Any other editor's commits reach the room through a git post-commit hook, and a tool of
your own can run the same generic hook (`npx agentmash hook`) or call the public API with a
personal token (`npx agentmash token`). What each agent gets is at
[agentmash.dev/setup](https://agentmash.dev/setup).

[The docs](https://agentmash.dev/docs) · [what leaves your machine](https://agentmash.dev/security) ·
[the crew](https://agentmash.dev/agents)

## Setup

1. **Connect the repository, once.** Someone who can push to it signs in with GitHub at
   [agentmash.dev/install](https://agentmash.dev/install) and picks it. Nothing is committed to it
   and there is no pull request.
2. **Each developer, once per machine:**

   ```bash
   npx agentmash login
   ```

   It opens GitHub in the browser. Once you have signed in there, type the code the terminal shows
   (`type this code in your browser: ABCD-EFGH`), so a sign-in link sent to someone else gives its
   sender nothing. Then it connects every coding agent it finds, in your own settings and never in
   a repository: Claude Code (`~/.claude/settings.json`), Codex (`~/.codex`), Cursor (`~/.cursor`)
   and GitHub Copilot (`~/.copilot`, and VS Code), and each other agent it knows in that agent's
   own settings folder. Devin reads Claude Code's settings. It works for
   every repository you can push to that anyone on your team has connected. GitHub's word on what you
   can push to lasts 30 days: after that, agentmash tells your session it is paused until you run
   `npx agentmash login` again.
3. **Restart Claude Code, or whichever agent you use.** In Codex, also open `/hooks` and approve
   agentmash: Codex runs no hook you haven't approved. From the next prompt on, prompts and edits go to the room. Before an
   agent edits a file a teammate's agent just changed, it is told who changed it, what changed and
   why.

`npx agentmash tools` shows which agents are connected; `npx agentmash logout` takes it all back out. Node.js 18.12 or newer; the CLI needs no checkout of
this project.

### Or commit it to the repository

The older way, for a server without GitHub sign-in. In your team's repo, once:

```bash
npx agentmash init
```

That creates a room on the coordination server, installs the hook scripts and the MCP
launcher into `.claude/agentmash/`, registers the hooks in `.claude/settings.json` without
disturbing anything already there, registers the MCP server in `.mcp.json`, writes the room
config beside them, and prints your dashboard link. Commit it:

```bash
git add .claude .mcp.json
git commit -m "add agentmash"
git push
```

Your teammates run `git pull` and sign in once on their machine, `npx agentmash login`: the
room's key opens it only beside the sign-in of someone who can push to the repository, so a copy
of the key in a fork or a CI log opens nothing. `init` signs your machine in first, connects the
room to the repository, then has it ask; one it could not connect opens to its key alone until
you run `npx agentmash connect`, then `npx agentmash secure sign-in`. `--key-only` makes a room its key alone opens, as
before; a room made that way, or before this version, needs a sign-in beside its key once its
admin runs `npx agentmash secure sign-in`.

## Commands

| Command | What it does |
| --- | --- |
| `npx agentmash login` | Sign this machine in with GitHub: agentmash for every connected repository you can push to |
| `npx agentmash logout` | Sign this machine out and take agentmash back out of every agent |
| `npx agentmash logout --all` | The same, and sign out every other machine signed in as you (one unused for 90 days signs out on its own) |
| `npx agentmash tools [add\|remove <agent>]` | Which coding agents are connected; connect or disconnect one |
| `npx agentmash init` | Create a room and wire up this repo |
| `npx agentmash join <id\|url>` | Point this repo at an existing room |
| `npx agentmash doctor` | Check exactly what is and isn't working |
| `npx agentmash status` | Who is working on what, from the terminal |
| `npx agentmash ask teammate "text"` | Send a teammate in this repo's room a request for their agent: a suggestion, read only |
| `npx agentmash inbox` | The requests waiting for you, and the ones you sent |
| `npx agentmash inbox accept <id>` | Say yes: prints the text for you to paste into your own agent, and marks it done |
| `npx agentmash inbox deny <id> [reason]` | Say no |
| `npx agentmash inbox show <id>` / `cancel <id>` | Read one whole; take back one you sent |
| `npx agentmash scan [path]` | How often this repo's AI agents changed the same files, from its git history, on this machine; `--card` makes an image to share (agentmash-scan) |
| `npx agentmash digest [--since 7d] [--to text\|json\|slack\|telegram]` | This repo's room over a period: who worked on what and where the agents collided, to your terminal, Slack or Telegram |
| `npx agentmash uninstall` | Remove the hooks from this repo |
| `npx agentmash crew add <name> --agents <a,b\|all>` | Put agents from the crew in this repo as a named team |
| `npx agentmash crew remove <name> [--agents <a,b>]` | Remove a team, or only the agents given |
| `npx agentmash crew list [--json]` | The teams installed in this repo |
| `npx agentmash crew update` | Rewrite the team files from the crew version this CLI carries |

Flags: `--server <url>` (coordination server), `--repo <path>`, `--label <text>`,
and `--force` with `init` to replace an existing room. With `crew`: `--agents`, `--slug <slug>`,
`--dry-run` to see what would change without writing, and `--force` to overwrite files that were
changed locally or not written by the crew.

Reach for `doctor` when someone's events aren't showing up. The hooks fail silently by
design, so it is the only thing that will tell you why: it resolves the config and shows
where each value came from, checks the hooks are registered, measures the round trip and
compares it against what a cold hook needs, validates the room, and lists the teammates it
can see.

### Asking a teammate's agent

`npx agentmash ask dana "check why ci is red on main"` sends dana a request for her agent. It is
a suggestion, read only, and nothing runs until dana accepts it: she sees it in
`npx agentmash inbox` and on the dashboard, and her agent is given one line about it when her next
session starts, or at a prompt within ten minutes, in agents whose hooks pass context to the model,
and in Claude Code also after its next edit. `npx agentmash inbox accept <id>` gives her the text
to paste into her own agent herself, and marks it done; nothing is ever sent into anyone's agent.
`accept`, `deny` and `show` run in her own terminal only: from an agent's shell they refuse. Both
of you need `npx agentmash login`, and both need push access to the room's repository.

## Crew teams

The [agentmash crew](https://github.com/agentmash-dev/agentmash-crew) is twenty-two Claude Code agents
with Mash, the conductor, in every team. `crew add` puts the ones you pick into this repo under a
name:

```bash
npx agentmash crew add "agentmash crew" --agents pipe,flex,probe
```

That writes the agents to `.claude/agents/`, the crew's skills and one skill for the team to
`.claude/skills/`, a guard hook to `.claude/agentmash-crew/` (registered in `.claude/settings.json`
beside anything already there), and a record of it all to `.claude/agentmash-crew/teams.json`. It
prints the `git add` for exactly those files. Commit them, start a new Claude Code session at the
repo root, and say `agentmash crew, <task>`.

`crew` was called `team` before, and `npx agentmash team` still runs it.

Teams have nothing to do with the room. `crew` never calls the coordination server, needs no
`init`, and `uninstall` leaves teams where they are. A file the crew did not write is never
overwritten without `--force`, and a refusal writes nothing at all. The files are the same bytes
the one-click pull request on agentmash.dev writes, and the crew's own installer's but for each
agent's model line (`crew/README.md` in this package lists them): all of them run the crew's
planner, which this package carries at the version pinned in `crew/crew.lock.json`.

## Running your own server

`login` and `init` point at a shared server by default. Self-hosting is part of the enterprise
plan: one container and one SQLite file. Ask at hello@agentmash.dev. The `docker run`, the
settings and the GitHub OAuth app people sign in with are at <https://agentmash.dev/docs/self-host>.
Then each developer signs in to it:

```bash
npx agentmash login --server https://agentmash.example.com
```

## What leaves your machine

File paths, branch names, the shape of each change (its line counts and the names it touches)
and the first 500 characters of each prompt, so teammates know what you are working on. Your
code stays on your machine unless your room turns diffs on, and `AGENTMASH_DIFFS=0` keeps yours
home whatever the room says; `AGENTMASH_HINTS=0` keeps your prompts home. In a committed install
the room id in `.claude/agentmash/` is the credential, so repo access is the security boundary.
`init`, `join` and `rotate` won't commit it to a repository GitHub says is public (`--allow-public-key`
commits it all the same, for anyone who reads the repository): connect a public one on the
website instead, and only people who can push get in. A key already in a public repository its
room is connected to opens the room only beside a sign-in that can push there. More at
<https://agentmash.dev/security>.

Full documentation, self-hosting instructions and limitations:
<https://agentmash.dev/docs>

MIT licensed.
