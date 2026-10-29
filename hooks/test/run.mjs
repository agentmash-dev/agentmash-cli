// `npm test` for the hooks: node --test over every test file, as many at once
// as AGENTMASH_TEST_CONCURRENCY says, or node's own default (a core less than
// the machine has). CI sets it low on a runner that shares its cores and is
// held to a few of them: each file starts hooks as agents do, several node processes at a time, and
// three files at once there starve one another past the time limits the tests
// hold the hooks to (tools/test-timing.mjs, within).

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const files = Number(process.env.AGENTMASH_TEST_CONCURRENCY);
const args = ['--test', ...(Number.isInteger(files) && files > 0 ? [`--test-concurrency=${files}`] : []), 'test/*.test.mjs'];
const run = spawnSync(process.execPath, args, { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit' });
process.exit(run.status ?? 1);
