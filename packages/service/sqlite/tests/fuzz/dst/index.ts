/**
 * Deterministic simulation testing (DST) helpers for sqlite-mem.
 *
 * - `engine.ts` — dump-after-each dual-engine runner
 * - `ops.ts` — shared mixed/DML op vocabulary + arbs
 * - `minimize.ts` — shrink a failing sequence to SQL text
 * - `repro.ts` — promote to `tests/corpus/regressions/` or `tests/dst/repros/`
 *
 * Replay:
 *   SQLITE_MEM_FUZZ_SEED=… bun test tests/fuzz/mixed-stateful.test.ts
 *   SQLITE_MEM_FUZZ_SEED=… SQLITE_MEM_FUZZ_PATH='0:1' bun test tests/fuzz
 *
 * Promote a minimized failing sequence:
 *   bun run scripts/promote-fuzz-repro.ts --slug my-bug --from tests/dst/repros/….sql
 */
export { runBoundDmlSequence, runSequence } from "./engine.ts";
export { formatReproAdvice, minimizeToSql } from "./minimize.ts";
export {
  DEFAULT_SCHEMA,
  SIMPLE_SCHEMA,
  dmlOpArb,
  mixedOpArb,
  schemaFor,
  schemaKindArb,
  type DmlOp,
  type MixedOp,
  type SchemaKind,
} from "./ops.ts";
export { writeCorpusRepro, writeDstReproArtifact } from "./repro.ts";
