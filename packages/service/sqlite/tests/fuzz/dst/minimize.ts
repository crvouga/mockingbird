import { DEFAULT_SCHEMA, type MixedOp, initialSimState, resolveOp } from "./ops.ts";

/**
 * Drop trailing / no-op ops and emit a linear SQL script that approximates the sequence.
 * Not a full delta-debugger — enough to hand-promote into corpus regressions.
 */
export function minimizeToSql(ops: readonly MixedOp[], schema = DEFAULT_SCHEMA): string {
  const state = initialSimState();
  const lines: string[] = [schema + ";"];

  for (const op of ops) {
    if (op.kind === "checkpoint") {
      lines.push("-- checkpoint (SQLM snapshot/restore on memory)");
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

export function formatReproAdvice(ops: readonly MixedOp[], seed: number): string {
  return [
    `-- minimized mixed DST repro (seed=${seed})`,
    `-- Replay: SQLITE_MEM_FUZZ_SEED=${seed} bun test tests/fuzz/mixed-stateful.test.ts`,
    minimizeToSql(ops).trimEnd(),
  ].join("\n");
}
