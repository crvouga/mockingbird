import { initialSimState, type MixedOp, resolveOp, type SchemaKind, schemaFor } from "./ops.ts";

/**
 * Emit a standalone SQL script that replays an op sequence (checkpoints noted
 * as comments — they are memory-only snapshot/restore round-trips).
 */
export function reproScript(ops: readonly MixedOp[], schemaKind: SchemaKind = "default"): string {
  const state = initialSimState(schemaKind);
  const lines: string[] = [`${schemaFor(schemaKind)};`];

  for (const op of ops) {
    if (op.kind === "checkpoint") {
      if (!state.inTxn) lines.push("-- checkpoint (PGMM snapshot / DELETE FROM t / restore on memory)");
      continue;
    }
    const resolved = resolveOp(op, state);
    if (resolved === null) continue;
    if (resolved.beginFirst) lines.push("BEGIN;");
    lines.push(`${resolved.sql};`);
  }
  if (state.inTxn) lines.push("COMMIT;");
  return `${lines.join("\n")}\n`;
}

export function formatReproAdvice(ops: readonly MixedOp[], seed: number, schemaKind: SchemaKind = "default"): string {
  return [
    `-- minimized DST repro (seed=${seed}, schema=${schemaKind})`,
    `-- Replay: POSTGRES_MEM_FUZZ_SEED=${seed} bun test tests/fuzz`,
    reproScript(ops, schemaKind).trimEnd(),
  ].join("\n");
}
