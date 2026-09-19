import { deepCompareResults } from "../harness/normalize.ts";
import type { ContractDb, QueryResult } from "../harness/types.ts";
import type { SimState } from "./dst/ops.ts";

/** Capture query results for a set of probe SELECTs. */
export function captureProbeResults(db: ContractDb, probes: readonly string[]): Map<string, QueryResult> {
  const out = new Map<string, QueryResult>();
  for (const sql of probes) {
    out.set(sql, db.query(sql));
  }
  return out;
}

/** Assert two probe-result maps are deeply equal. */
export function assertProbeResultsEqual(
  label: string,
  before: Map<string, QueryResult>,
  after: Map<string, QueryResult>,
): void {
  for (const [sql, expected] of before) {
    const actual = after.get(sql);
    if (!actual) throw new Error(`${label}: missing probe ${sql}`);
    const cmp = deepCompareResults(expected, actual, { ignoreWriteCounters: true });
    if (!cmp.equal) {
      throw new Error(`${label} probe mismatch for ${sql}: ${cmp.reason}`);
    }
  }
}

/** Compare probe results between memory and oracle. */
export function compareProbeResultsOrReport(
  label: string,
  memory: ContractDb,
  oracle: ContractDb,
  probes: readonly string[],
): void {
  for (const sql of probes) {
    const mem = memory.query(sql);
    const ora = oracle.query(sql);
    const cmp = deepCompareResults(mem, ora, { ignoreWriteCounters: true, ignoreErrorPhase: true });
    if (!cmp.equal) {
      throw new Error(`${label} oracle probe mismatch for ${sql}: ${cmp.reason}`);
    }
  }
}

/** Build default + accumulated probe queries from DST sim state. */
export function probesForState(state: SimState): string[] {
  const cols = state.schemaKind === "generated" ? "id, a, b, g" : "id, a, b";
  const probes = new Set<string>([`SELECT ${cols} FROM t ORDER BY id`, ...state.probeQueries]);
  if (state.hasView) probes.add("SELECT id, a FROM t_view ORDER BY id");
  if (state.hasChild) probes.add("SELECT id, tid, note FROM child ORDER BY id");
  if (state.hasIndex) probes.add("SELECT id, a, b FROM t WHERE a IS NOT NULL ORDER BY id");
  if (state.hasPartialIndex) probes.add("SELECT id, a, b FROM t WHERE a > 0 ORDER BY id");
  if (state.hasExprIndex) probes.add("SELECT id, a, b FROM t WHERE a + 1 > 0 ORDER BY id");
  if (state.hasUniqueIndex) probes.add("SELECT id, a, b FROM t ORDER BY a, id");
  return [...probes];
}

export interface SnapshotCheckpointOptions {
  destructiveSql?: string;
}

/**
 * Memory-only snapshot round-trip with probe verification.
 * Returns the snapshot bytes for idempotence / encode-stability tests.
 */
export function runSnapshotCheckpoint(
  memory: ContractDb,
  probes: readonly string[],
  options?: SnapshotCheckpointOptions,
): Uint8Array {
  const before = captureProbeResults(memory, probes);
  const snap = memory.snapshot();
  memory.exec(options?.destructiveSql ?? "DELETE FROM t WHERE 1");
  memory.restore(snap);
  const after = captureProbeResults(memory, probes);
  assertProbeResultsEqual("snapshot-checkpoint", before, after);
  return snap;
}
