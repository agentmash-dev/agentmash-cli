// `npx agentmash digest`: the weekly digest, what the team's agents did over a
// period and where they kept colliding, to the terminal, Slack or Telegram.
// It is the digest in the repository's digest/ (README.md, "Weekly digest"),
// which reads every word after `digest` itself:
//
//   npx agentmash digest [--since 7d] [--to text|json|slack|telegram] [--webhook URL] …
//
// sync-hooks.mjs packs a copy of it into cli/digest/, as it does the hooks,
// so the package carries it and npx fetches nothing more. What this command
// adds is the room: agentmash.mjs finds it the way the rest of the CLI does
// (digestRoom), so a checkout of a repository connected on the website, with
// this machine signed in, has one with nothing committed, and a room that
// asks for a sign-in beside its key gets this machine's.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The digest's files, as sync-hooks.mjs copies them: the command line and what it loads. */
export const DIGEST_FILES = ['src/cli.mjs', 'src/aggregate.mjs', 'src/net.mjs', 'src/render.mjs'];

/**
 * The digest: the repo checkout's digest/ in dev, or the copy sync-hooks.mjs
 * packs into the published package. Checkout first, for the reason
 * hookSourceDir gives: cli/digest/ is a copy that goes stale the moment
 * someone edits digest/.
 */
export function digestSourceDir() {
  for (const candidate of [path.join(HERE, '..', 'digest'), path.join(HERE, 'digest')]) {
    if (DIGEST_FILES.every((f) => fs.existsSync(path.join(candidate, f)))) return candidate;
  }
  return null;
}

export async function cmdDigest(words, { roomOf }) {
  const dir = digestSourceDir();
  if (!dir) {
    console.error('could not locate the digest (broken package?)');
    process.exitCode = 1;
    return;
  }
  const { runDigest } = await import(pathToFileURL(path.join(dir, 'src', 'cli.mjs')).href);
  await runDigest(words, { name: 'npx agentmash digest', findRoom: roomOf });
}
