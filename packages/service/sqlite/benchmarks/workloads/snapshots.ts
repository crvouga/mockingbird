import { maybeGc, sampleMemory } from "../harness/memory.ts";
import type { BenchEngine, BenchSpec } from "../harness/types.ts";
import { fillPayload, fillUsers } from "./populate.ts";
import { spec } from "./tiers.ts";

interface SnapshotTarget {
  name: string;
  rows: number;
  payloadBytes: number;
  tiers: BenchSpec["tiers"];
}

/** Approximate snapshot sizes via row count × payload. */
const TARGETS: SnapshotTarget[] = [
  { name: "small", rows: 200, payloadBytes: 64, tiers: ["ci", "default", "full"] },
  { name: "1mb", rows: 1_000, payloadBytes: 1_024, tiers: ["ci", "default", "full"] },
  { name: "5mb", rows: 5_000, payloadBytes: 1_024, tiers: ["default", "full"] },
  { name: "10mb", rows: 10_000, payloadBytes: 1_024, tiers: ["full"] },
  { name: "25mb", rows: 25_000, payloadBytes: 1_024, tiers: ["full"] },
  { name: "50mb", rows: 50_000, payloadBytes: 1_024, tiers: ["full"] },
  { name: "100mb", rows: 100_000, payloadBytes: 1_024, tiers: ["full"] },
];

function populateSnapshotDb(engine: BenchEngine, rows: number, payloadBytes: number): void {
  fillPayload(engine, rows, payloadBytes);
}

export function snapshotSpecs(): BenchSpec[] {
  const specs: BenchSpec[] = [];

  for (const target of TARGETS) {
    specs.push(
      spec({
        name: `snapshot/export/${target.name}`,
        operation: "snapshot export",
        datasetSize: target.rows,
        tiers: target.tiers,
        layer: "engine",
        warmup: target.rows >= 25_000 ? 0 : 1,
        iterations: target.rows >= 25_000 ? 1 : 3,
        setup: (engine) => {
          populateSnapshotDb(engine, target.rows, target.payloadBytes);
          maybeGc();
          return { before: sampleMemory() };
        },
        fn: (engine, ctx) => {
          const snap = engine.snapshot();
          const state = ctx as {
            before: ReturnType<typeof sampleMemory>;
            snap?: Uint8Array;
            after?: ReturnType<typeof sampleMemory>;
          };
          state.snap = snap;
          state.after = sampleMemory();
        },
        extra: (ctx) => {
          const state = ctx as { snap?: Uint8Array };
          return state.snap ? { snapshotBytes: state.snap.byteLength } : undefined;
        },
      }),
      spec({
        name: `snapshot/hydrate/${target.name}`,
        operation: "snapshot hydrate",
        datasetSize: target.rows,
        tiers: target.tiers,
        layer: "engine",
        isolateIterations: target.rows >= 25_000,
        warmup: target.rows >= 25_000 ? 0 : 1,
        iterations: target.rows >= 25_000 ? 1 : 3,
        setup: (engine) => {
          populateSnapshotDb(engine, target.rows, target.payloadBytes);
          const bytes = engine.snapshot();
          // Clear live rows before timed restore so peak reflects hydrate cost,
          // not (live DB + decoded).
          engine.exec("DELETE FROM blobs");
          maybeGc();
          return { bytes, size: bytes.byteLength, before: sampleMemory() };
        },
        fn: (engine, ctx) => {
          const state = ctx as { bytes: Uint8Array; after?: ReturnType<typeof sampleMemory> };
          // New view so WeakMap hydrate cache does not turn this into a CoW open.
          engine.restore(state.bytes.subarray(0));
          state.after = sampleMemory();
        },
        extra: (ctx) => {
          const state = ctx as {
            size?: number;
            before?: ReturnType<typeof sampleMemory>;
            after?: ReturnType<typeof sampleMemory>;
          };
          const out: Record<string, number | string> = {};
          if (state.size !== undefined) out.snapshotBytes = state.size;
          if (state.before?.heapUsed !== undefined && state.after?.heapUsed !== undefined) {
            out.heapDelta = state.after.heapUsed - state.before.heapUsed;
          }
          if (state.before?.rss !== undefined && state.after?.rss !== undefined) {
            out.rssDelta = state.after.rss - state.before.rss;
          }
          return out;
        },
      }),
      spec({
        name: `snapshot/roundtrip/${target.name}`,
        operation: "export+hydrate+query",
        datasetSize: target.rows,
        tiers: target.tiers,
        layer: "engine",
        warmup: 0,
        iterations: 1,
        setup: (engine) => {
          populateSnapshotDb(engine, target.rows, target.payloadBytes);
        },
        fn: (engine) => {
          const bytes = engine.snapshot();
          engine.restore(bytes);
          engine.query("SELECT id FROM blobs WHERE id = 1");
          engine.query("SELECT COUNT(*) AS c FROM blobs");
        },
      }),
    );
  }

  specs.push(
    spec({
      name: "snapshot/incremental-opportunity/1mb",
      operation: "full export after 1% change",
      datasetSize: 1000,
      tiers: ["default", "full"],
      warmup: 0,
      iterations: 3,
      setup: (engine) => {
        fillUsers(engine, 1000);
        const baseline = engine.snapshot();
        engine.exec("UPDATE users SET name = 'changed' WHERE id <= 10");
        return { baselineBytes: baseline.byteLength };
      },
      fn: (engine, ctx) => {
        const snap = engine.snapshot();
        (ctx as { afterBytes?: number }).afterBytes = snap.byteLength;
      },
    }),
    spec({
      name: "snapshot/fidelity/200",
      operation: "roundtrip fidelity",
      datasetSize: 200,
      tiers: ["ci", "default", "full"],
      warmup: 0,
      iterations: 1,
      engines: "mem",
      setup: (engine) => {
        fillUsers(engine, 200);
        engine.exec("CREATE VIEW v_users AS SELECT id, name FROM users");
      },
      fn: (engine) => {
        const before = engine.query("SELECT id, email, name FROM users ORDER BY id");
        const snap = engine.snapshot();
        engine.exec("DELETE FROM users");
        engine.restore(snap);
        const after = engine.query("SELECT id, email, name FROM users ORDER BY id");
        if (before.length !== after.length) throw new Error("snapshot fidelity: row count mismatch");
        for (let i = 0; i < before.length; i++) {
          const b = before[i] as Record<string, unknown>;
          const a = after[i] as Record<string, unknown>;
          if (b.id !== a.id || b.email !== a.email || b.name !== a.name) {
            throw new Error(`snapshot fidelity: row ${i} mismatch`);
          }
        }
      },
    }),
  );

  return specs;
}
