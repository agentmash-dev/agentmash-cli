/**
 * The time limits the tests hold code to, on the machine they run on: the
 * server's, the hooks' and the CLI's tests all take theirs from here.
 *
 * On a developer's machine a limit is the one the test says, and a
 * measurement gets one take. On CI (CI set, as GitHub Actions sets it on
 * every job) the runner can be a shared machine held to a few cores, while
 * several test files run at once. A
 * symbol check held to 25 ms took 57 there, and two detached hooks ran past
 * a wait made for a laptop. So on CI a limit stretches by SLOWNESS, and a
 * measurement that still misses is taken once more (timed).
 *
 * It stretches how long a test waits or allows. A limit the code itself
 * keeps, a shutdown's grace or a host's own timeout, is checked as it is.
 *
 * The server's tests compile against tools/test-timing.d.mts.
 */
import { performance } from 'node:perf_hooks';

/** Whether this runs on CI: CI set to anything but false or 0. */
export const ON_CI = Boolean(process.env.CI) && !/^(?:false|0)$/i.test(process.env.CI ?? '');

const asked = Number(process.env.AGENTMASH_TEST_SLOWNESS);

/**
 * How many times slower than a developer's machine this one is taken to be:
 * AGENTMASH_TEST_SLOWNESS where it is set (ci.yml: 4 on our own runner, 2 on
 * GitHub's Windows one), else 2 on CI and 1 anywhere else.
 */
export const SLOWNESS = Number.isFinite(asked) && asked >= 1 ? asked : ON_CI ? 2 : 1;

/** A limit of `ms`, stretched by SLOWNESS. */
export const within = (ms) => ms * SLOWNESS;

/** How many more takes a measurement that missed its limit gets: one on CI, none anywhere else. */
export const RETRIES = ON_CI ? 1 : 0;

/**
 * Times `run`, synchronous code a test can run again as it is, against a
 * limit of `budgetMs` (stretched, `within`). Returns `{ ms, limit, value }`:
 * the fastest take's time, the stretched limit, and what the last take
 * returned. A take past the limit is taken again on CI, once, so a moment
 * the cores went to the site does not fail the test; anywhere else the first
 * take is the only one. The test asserts `ms < limit` with its own words.
 */
export function timed(budgetMs, run) {
  const limit = within(budgetMs);
  let ms = Infinity;
  let value;
  for (let take = 0; take <= RETRIES; take++) {
    const started = performance.now();
    value = run();
    ms = Math.min(ms, performance.now() - started);
    if (ms < limit) break;
  }
  return { ms, limit, value };
}
