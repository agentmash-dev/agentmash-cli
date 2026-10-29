# Security

## Reporting a vulnerability

Email [hello@agentmash.dev](mailto:hello@agentmash.dev) with the subject `security`. Please
don't open a public issue for it.

Include:

- what you found, and what someone could do with it
- where: the component (`cli/`, `hooks/`, `mcp/`, ...) and the version of the npm package
  or the commit
- the steps to reproduce it, or a proof of concept
- whether anyone else knows, and any date you plan to publish

We answer within 3 days. We fix what we confirm ourselves, tell you when the fix ships, and
credit you in the release notes if you want.

We don't run a bug bounty and don't pay for reports.

## Rules for testing

- Test against your own rooms. A room on agentmash.dev is free for 2 developers, and the
  test suites run every client against a local mock server.
- Don't read, change or delete data in rooms that aren't yours, and don't use keys or tokens
  you find that belong to someone else.
- Don't attack agentmash.dev's infrastructure: no denial of service, no load or volume
  testing, no scanning of our hosts, no social engineering of our team or users.

Good-faith research that follows these rules is welcome.

## Supported versions

Fixes go into the latest release of the npm package `agentmash` and the `main` branch of this
repository. agentmash.dev runs the latest server.

## How keys work

A room has a key, `mash_...`. `npx agentmash init` and `npx agentmash join` write it into
`.claude/agentmash/config.json`, and that file is meant to be committed, so teammates get the
room with a `git pull`. This is by design (see [cli/README.md](cli/README.md)).

- The room key is a shared secret for the room. Whoever holds it can report to the room, read
  it, and administer it: change its settings, rotate the key, purge its data or delete it.
- So treat read access to the repository as access to the room. Anyone who can clone the repo
  can use the room.
- `init`, `join` and `rotate` won't commit a key to a repository GitHub says is public, unless
  you pass `--allow-public-key`.
- `npx agentmash rotate` makes a new key. The old one keeps working for a grace period (3 days
  by default, `--grace-minutes` to change it), and `npx agentmash revoke` ends it at once.
- With GitHub sign-in, `npx agentmash secure sign-in` makes the room open only to
  its key together with the sign-in of someone who can push to the repository. A copy of the
  key in a fork or a CI log then opens nothing on its own.

Other credentials:

- `npx agentmash login` keeps the machine's sign-in in `~/.agentmash/user.json`, with file
  mode 0600. It goes to the server you signed in to, or to the one `AGENTMASH_URL` names when
  that is set. No GitHub token is kept on the machine.
- Personal API tokens from `npx agentmash token create` are printed once and never stored by
  the CLI.

Every credential travels as a header, so a server anyone reaches over a network belongs behind
HTTPS. What the client sends, and where, is in [WIRE.md](WIRE.md).
