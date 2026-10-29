# Contributing

Thanks for looking. Issues and pull requests are welcome. For a security problem, don't open an
issue: see [SECURITY.md](SECURITY.md).

## Sign off every commit (DCO)

Every commit needs a `Signed-off-by` line. It says you wrote the change, or have the right to
submit it, under this repository's MIT license, as the
[Developer Certificate of Origin](https://developercertificate.org/) puts it. Git adds the line
for you:

```bash
git commit -s -m "your message"
```

To sign off commits you already made on your branch: `git rebase --signoff main`.

## How a change lands

This repository is exported from the one we deploy from. For now, when we take your pull
request, we apply it there with you as the author, and it comes back here with the next export.
So GitHub may show your pull request as closed rather than merged; we'll say which commit it
landed as.

## Running the tests

You need Node.js 22 (what CI uses) and git. From the repository root:

```bash
npm ci

npm test -w hooks
npm test -w cli
npm test -w mcp
npm test -w digest
node --test clients/test/*.test.mjs
```

The hook tests start real hook processes and have time limits. On a slow machine, or on
Windows, stretch them and run fewer at once:

```bash
AGENTMASH_TEST_SLOWNESS=2 AGENTMASH_TEST_CONCURRENCY=2 npm test -w hooks
```

To try your change by hand, run the CLI from your checkout in a scratch repository, for example
`node /path/to/agentmash-cli/cli/agentmash.mjs doctor`. The tests use a local mock server
(`cli/test/mock-server.mjs`), so they need no account and no network.

## A few rules the code keeps

- The npm package `agentmash` has no runtime dependencies. Client code is plain Node.js ESM
  that imports only `node:` built-ins and relative files. Keep it that way.
- Hooks fail open. A slow, wrong or missing server means the hook prints nothing and exits 0,
  and the agent's edit goes on.
- Files keep LF line endings (`.gitattributes`). The package build refuses CRLF files.
- A change to what a client sends, or to a route, updates [PROTOCOL.md](PROTOCOL.md) and
  [WIRE.md](WIRE.md) in the same pull request.
