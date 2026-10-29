/**
 * Types for tools/test-timing.mjs, the time limits the tests hold code to.
 * The server compiles without allowJs, and under NodeNext a `.mjs` import
 * takes its types from the `.d.mts` beside it.
 */

/** Whether this runs on CI: CI set to anything but false or 0. */
export declare const ON_CI: boolean;
/** AGENTMASH_TEST_SLOWNESS where it is set, else 2 on CI and 1 anywhere else. */
export declare const SLOWNESS: number;
/** How many more takes a measurement that missed its limit gets: one on CI, none anywhere else. */
export declare const RETRIES: number;
/** A limit of `ms`, stretched by SLOWNESS. */
export declare function within(ms: number): number;
/** `run` timed against `within(budgetMs)`, taken once more on CI when it missed: the fastest take, the limit, the last value. */
export declare function timed<T>(budgetMs: number, run: () => T): { ms: number; limit: number; value: T };
