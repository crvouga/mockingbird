import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { Database, Snapshot } from "../../src/index.ts";
import { InMemoryAdapter } from "../adapters/in-memory.ts";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { initialSimState, mixedOpArb, schemaFor, schemaKindArb } from "./dst/ops.ts";
import { runSequenceOrMinimize } from "./dst/engine.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";
import {
  assertProbeResultsEqual,
  captureProbeResults,
  probesForState,
  runSnapshotCheckpoint,
} from "./snapshot-helpers.ts";

const steps = Number(process.env.POSTGRES_MEM_SNAPSHOT_STEPS ?? "20");

const safeTextArb = fc.string({
  minLength: 0,
  maxLength: 16,
  unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-".split("")),
});

describe("snapshot restore fuzz (FZZ-snap-01)", () => {
  test("mixed sequences with checkpoints preserve probes and logical state", async () => {
    await fc.assert(
      fc.asyncProperty(
        schemaKindArb,
        fc.array(mixedOpArb, { minLength: 10, maxLength: steps }),
        async (schemaKind, ops) => {
          await runSequenceOrMinimize(ops, { label: "snap-mixed", schemaKind, finalizeCommit: true });
        },
      ),
      fuzzAssertConfig(12),
    );
  }, 120_000);

  test("restore is idempotent on probe results", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("default" as const, "simple" as const),
        fc.array(fc.record({ a: intArb, b: safeTextArb }), { minLength: 1, maxLength: 8 }),
        async (schemaKind, rows) => {
          const memory = new InMemoryAdapter();
          try {
            await memory.exec(schemaFor(schemaKind));
            for (const row of rows) {
              if (schemaKind === "default") {
                await memory.exec(
                  `INSERT INTO t (a, b, c) VALUES (${row.a ?? "NULL"}, '${row.b.replaceAll("'", "''")}', 1.0)`,
                );
              } else {
                await memory.exec(
                  `INSERT INTO t (id, a, b) VALUES (${rows.indexOf(row) + 1}, ${row.a ?? "NULL"}, '${row.b.replaceAll("'", "''")}')`,
                );
              }
            }
            const probes = probesForState(initialSimState(schemaKind));
            const before = await captureProbeResults(memory, probes);
            const snap = memory.snapshot();
            memory.restore(snap);
            memory.restore(snap);
            const after = await captureProbeResults(memory, probes);
            assertProbeResultsEqual("idempotent-restore", before, after);
          } finally {
            await memory.close();
          }
        },
      ),
      fuzzAssertConfig(12),
    );
  }, 60_000);

  test("snapshot bytes stable after insert-then-delete round-trip", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("default" as const, "simple" as const),
        fc.array(fc.record({ a: intArb, b: safeTextArb }), { minLength: 1, maxLength: 6 }),
        async (schemaKind, rows) => {
          const db = new Database({ seed: 42 });
          try {
            db.exec(schemaFor(schemaKind));
            for (const [i, row] of rows.entries()) {
              if (schemaKind === "default") {
                db.exec(
                  `INSERT INTO t (id, a, b, c) VALUES (${i + 1}, ${row.a ?? "NULL"}, '${row.b.replaceAll("'", "''")}', 1.0)`,
                );
              } else {
                db.exec(
                  `INSERT INTO t (id, a, b) VALUES (${i + 1}, ${row.a ?? "NULL"}, '${row.b.replaceAll("'", "''")}')`,
                );
              }
            }
            const direct = db.snapshot().encode();
            const tmpId = rows.length + 99;
            if (schemaKind === "default") {
              db.exec(`INSERT INTO t (id, a, b, c) VALUES (${tmpId}, 0, 'tmp', 0)`);
            } else {
              db.exec(`INSERT INTO t (id, a, b) VALUES (${tmpId}, 0, 'tmp')`);
            }
            db.exec(`DELETE FROM t WHERE id = ${tmpId}`);
            const after = db.snapshot().encode();
            expect(after).toEqual(direct);
          } finally {
            db.close();
          }
        },
      ),
      fuzzAssertConfig(12),
    );
  }, 60_000);

  test("views and materialized views survive snapshot restore", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ a: intArb, b: safeTextArb }), { minLength: 1, maxLength: 6 }),
        async (rows) => {
          const memory = new InMemoryAdapter();
          try {
            await memory.exec("CREATE TABLE t (id serial PRIMARY KEY, a int, b text, c float8)");
            await memory.exec("CREATE VIEW t_view AS SELECT id, a FROM t");
            await memory.exec("CREATE MATERIALIZED VIEW t_mv AS SELECT id, a FROM t");
            for (const row of rows) {
              await memory.exec(
                `INSERT INTO t (a, b, c) VALUES (${row.a ?? "NULL"}, '${row.b.replaceAll("'", "''")}', 1.0)`,
              );
            }
            const probes = [
              "SELECT id, a FROM t_view ORDER BY id",
              "SELECT id, a FROM t_mv ORDER BY id",
              "SELECT id, a, b FROM t ORDER BY id",
            ];
            await runSnapshotCheckpoint(memory, probes);
            await memory.exec("REFRESH MATERIALIZED VIEW t_mv");
            expect((await memory.query("SELECT id, a FROM t_mv ORDER BY id")).rows).toEqual(
              (await memory.query("SELECT id, a FROM t ORDER BY id")).rows,
            );
          } finally {
            await memory.close();
          }
        },
      ),
      fuzzAssertConfig(12),
    );
  }, 60_000);

  test("indexed lookups agree with oracle after snapshot restore", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ id: fc.integer({ min: 1, max: 12 }), a: intArb }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: -20, max: 20 }),
        async (rows, probe) => {
          await withDatabases(async (memory, postgres) => {
            for (const db of [memory, postgres]) {
              await db.exec("CREATE TABLE t (id int PRIMARY KEY, a int)");
              await db.exec("CREATE INDEX t_a_idx ON t (a)");
              for (const row of rows) {
                await db.exec(`INSERT INTO t VALUES (${row.id}, ${row.a ?? "NULL"})`);
              }
            }
            const probes = [
              `SELECT id, a FROM t WHERE a = ${probe ?? "NULL"} ORDER BY id`,
              "SELECT id, a FROM t ORDER BY id",
            ];
            await runSnapshotCheckpoint(memory, probes);
            for (const sql of probes) {
              compareOrReport(
                "index-post-restore",
                sql,
                { rows, probe },
                await memory.query(sql),
                await postgres.query(sql),
              );
            }
          });
        },
      ),
      fuzzAssertConfig(16),
    );
  }, 90_000);

  test("Snapshot.open() CoW forks preserve parent probe results", () => {
    fc.assert(
      fc.property(intArb, safeTextArb, (a, b) => {
        const db = new Database({ seed: 1 });
        try {
          db.exec("CREATE TABLE t (id serial PRIMARY KEY, a int, b text)");
          db.exec("INSERT INTO t (a, b) VALUES (10, 'x')");
          const before = db.query("SELECT id, a, b FROM t ORDER BY id");
          const snap = db.snapshot();
          const child = snap.open();
          child.exec(`INSERT INTO t (a, b) VALUES (${a}, '${b.replaceAll("'", "''")}')`);
          expect(db.query("SELECT id, a, b FROM t ORDER BY id")).toEqual(before);
          expect(child.query("SELECT id, a, b FROM t ORDER BY id").length).toBe(2);
          child.close();
        } finally {
          db.close();
        }
      }),
      fuzzAssertConfig(12),
    );
  });

  test("double decode yields identical probe results", () => {
    const db = new Database({ seed: 99 });
    try {
      db.exec("CREATE TABLE t (id serial PRIMARY KEY, a int)");
      db.exec("CREATE VIEW v AS SELECT id, a FROM t");
      db.exec("INSERT INTO t (a) VALUES (2)");
      const bytes = db.snapshot().encode();
      const a = Snapshot.decode(bytes).open();
      const b = Snapshot.decode(bytes).open();
      const probes = ["SELECT id, a FROM t ORDER BY id", "SELECT id, a FROM v ORDER BY id"];
      for (const sql of probes) {
        expect(a.query(sql)).toEqual(b.query(sql));
      }
      a.close();
      b.close();
    } finally {
      db.close();
    }
  });
});
