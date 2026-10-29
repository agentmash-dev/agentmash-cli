# Open or local models

agentmash doesn't pick your model. It connects the coding agents your team already runs, so a
team on open-weight models, or on models running on its own machines, works in the same room as
everyone else. Today that's through three open source agents that run whatever model you set up
in them: OpenCode, goose and Qwen Code.

agentmash never sees a model key. Each agent signs in or takes its key with its own command, in
its own terminal, and keeps it in its own settings.

## In the desktop app

The app's agents page lists OpenCode and goose, and installs either with its maker's own command (goose on
macOS and Linux: its maker has no Windows install yet, so there its card links to goose's install docs).

- **OpenCode** starts on its own free models, with nothing to set up. **Add a provider** on its
  card opens `opencode auth login` in a terminal, for any provider OpenCode supports. A model on
  your own machine (Ollama, LM Studio or any OpenAI-compatible server) goes in OpenCode's own
  config, as [its providers page](https://opencode.ai/docs/providers/) shows.
- **goose** runs the provider you pick with `goose configure` (its card's **Set up its
  provider**), Ollama among them.

Both run in the app as chats, side by side with Claude Code and Codex, each on its own setup.

## In a terminal

`npx agentmash login` connects OpenCode, goose and Qwen Code at user level, beside Claude Code
and Codex: a plugin for OpenCode, a plugin folder for goose, hooks in `~/.qwen/settings.json`
for Qwen Code. Each one reports its edits to the room, and before its first edit of a file a
teammate's agent is changing, that edit is refused once with the reason, so the agent sees who
and why before it goes on. What each one can and can't see is in
[the adapters](https://agentmash.dev/docs/adapters).

Qwen Code sets up its provider and key itself: run `/auth` in it.
