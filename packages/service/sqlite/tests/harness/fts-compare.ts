/**
 * FTS ranking / highlight results must remain order-sensitive.
 * deepCompareResults never sorts rows; FTS tests must use ORDER BY when
 * ranking order is part of the observable result, and prefer exact real
 * equality (Object.is) for bm25/rank scores. A narrow tolerance may be
 * introduced only if same-process oracle floats prove non-bit-identical.
 */
export { deepCompareResults, normalizeQueryResult } from "./normalize.ts";
