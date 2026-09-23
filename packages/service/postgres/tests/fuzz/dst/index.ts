/**
 * Deterministic simulation testing (DST) helpers for postgres-mem.
 *
 * - `ops.ts` — stateful/mixed op vocabulary, SimState resolution, fast-check arbs
 * - `engine.ts` — dump-after-each dual-engine runner (memory vs PGlite oracle)
 * - `minimize.ts` — greedy async op-removal that preserves a failure
 * - `repro.ts` — standalone SQL repro-script emitter
 *
 * Replay:
 *   POSTGRES_MEM_FUZZ_SEED=… bun test tests/fuzz/stateful.test.ts
 *   POSTGRES_MEM_FUZZ_SEED=… POSTGRES_MEM_FUZZ_PATH='0:1' bun test tests/fuzz
 */
export { type RunSequenceOptions, runSequence, runSequenceOrMinimize } from "./engine.ts";
export { type FailureCheck, type MinimizeOptions, minimizeOps } from "./minimize.ts";
export {
  DEFAULT_SCHEMA,
  initialSimState,
  type MixedOp,
  mixedOpArb,
  OUTCOME_KINDS,
  QUERY_KINDS,
  resolveOp,
  type SchemaKind,
  SIMPLE_SCHEMA,
  type SimState,
  type StatefulOp,
  schemaFor,
  schemaKindArb,
  statefulOpArb,
} from "./ops.ts";
export { formatReproAdvice, reproScript } from "./repro.ts";
