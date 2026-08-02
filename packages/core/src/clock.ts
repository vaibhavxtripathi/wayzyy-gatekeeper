/**
 * Monotonic clock shim.
 *
 * core has zero runtime dependencies and must run in Node, the browser, and
 * workers alike (SPEC §1, §11), so we reach for `performance.now()` without
 * assuming @types/node or DOM libs are present.
 */

interface PerformanceLike {
  now(): number;
}

const perf: PerformanceLike | undefined = (
  globalThis as unknown as { performance?: PerformanceLike }
).performance;

/** High-resolution monotonic timestamp in milliseconds. */
export function now(): number {
  return perf !== undefined ? perf.now() : Date.now();
}
