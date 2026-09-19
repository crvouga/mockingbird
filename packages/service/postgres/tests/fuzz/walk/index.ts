/**
 * State-dependent random-walk DST (Antithesis-style) for postgres-mem.
 *
 * Env:
 *   POSTGRES_MEM_WALK_STEPS — walk depth (default 30)
 *   POSTGRES_MEM_FUZZ_SEED / PATH / RUNS — via fuzzAssertConfig
 *
 * Soak:
 *   bun run test:walk:soak -- --depth 200 --runs 20
 */
export { bootstrapDdl, buildStep } from "./actions.ts";
export { ChoiceSource, DRAWS_PER_STEP, decisionVectorArb, walkDepth } from "./choice.ts";
export {
  type ActionKind,
  enabledActions,
  initialWalkModel,
  type WalkModel,
  type WalkStep,
} from "./model.ts";
export { formatWalkRepro, minimizeTrace, replayTrace, runWalkOrMinimize } from "./replay.ts";
export { buildTraceOnly, type RunWalkOptions, runWalk } from "./runner.ts";
