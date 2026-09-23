import { deepCompareResults } from "../harness/normalize.ts";
import type { ContractDb, QueryResult } from "../harness/types.ts";
import type { SimState } from "./dst/ops.ts";

/** Capture query results for a set of probe SELECTs. */
export async function captureProbeResults(
  db: ContractDb,
  probes: readonly string[],
): Promise<Map<string, QueryResult>> {
  const out = new Map<string, QueryResult>();
  for (const sql of probes) {
    out.set(sql, await db.query(sql));
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
export async function compareProbeResultsOrReport(
  label: string,
  memory: ContractDb,
  oracle: ContractDb,
  probes: readonly string[],
): Promise<void> {
  for (const sql of probes) {
    const mem = await memory.query(sql);
    const ora = await oracle.query(sql);
    const cmp = deepCompareResults(mem, ora, { ignoreWriteCounters: true, ignoreErrorPhase: true });
    if (!cmp.equal) {
      throw new Error(`${label} oracle probe mismatch for ${sql}: ${cmp.reason}`);
    }
  }
}

/** Build default + accumulated probe queries from DST sim state. */
export function probesForState(state: SimState): string[] {
  const cols = state.schemaKind === "default" ? "id, a, b, c" : "id, a, b";
  const noteCol = state.hasNote ? ", note" : "";
  const probes = new Set<string>([`SELECT ${cols}${noteCol} FROM t ORDER BY id`, ...state.probeQueries]);
  if (state.hasView) probes.add("SELECT id, a FROM t_view ORDER BY id");
  if (state.hasMatView) probes.add("SELECT id, a FROM t_mv ORDER BY id");
  if (state.hasIndex) probes.add("SELECT id, a, b FROM t WHERE a IS NOT NULL ORDER BY id");
  if (state.hasPartialIndex) probes.add("SELECT id, a, b FROM t WHERE a > 0 ORDER BY id");
  if (state.hasSequence) {
    probes.add("SELECT last_value::text AS last_value FROM pg_sequences WHERE sequencename = 't_id_seq'");
  }
  if (state.schemaKind === "multi_schema") probes.add("SELECT id, a FROM other.t ORDER BY id");
  return [...probes];
}

export interface SnapshotCheckpointOptions {
  destructiveSql?: string;
}

/**
 * Memory-only snapshot round-trip with probe verification.
 * Returns the snapshot bytes for idempotence / encode-stability tests.
 */
export async function runSnapshotCheckpoint(
  memory: ContractDb,
  probes: readonly string[],
  options?: SnapshotCheckpointOptions,
): Promise<Uint8Array> {
  const before = await captureProbeResults(memory, probes);
  const snap = memory.snapshot();
  await memory.exec(options?.destructiveSql ?? "DELETE FROM t");
  memory.restore(snap);
  const after = await captureProbeResults(memory, probes);
  assertProbeResultsEqual("snapshot-checkpoint", before, after);
  return snap;
}
