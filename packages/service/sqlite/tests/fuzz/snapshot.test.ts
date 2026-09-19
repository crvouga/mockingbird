import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { Database, Snapshot } from "../../src/index.ts";
import { InMemoryAdapter } from "../adapters/in-memory.ts";
import { fuzzAssertConfig, intArb, textArb } from "./config.ts";
import { initialSimState, mixedOpArb, schemaFor, schemaKindArb } from "./dst/ops.ts";
import { runSequence } from "./dst/engine.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";
import {
  assertProbeResultsEqual,
  captureProbeResults,
  probesForState,
  runSnapshotCheckpoint,
} from "./snapshot-helpers.ts";

const steps = Number(process.env.SQLITE_MEM_SNAPSHOT_STEPS ?? "20");

const safeTextArb = fc.string({
  minLength: 0,
  maxLength: 16,
  unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-".split("")),
});

describe("snapshot restore fuzz (FZZ-snap-01)", () => {
  test("mixed sequences with checkpoints preserve probes and logical state", () => {
    fc.assert(
      fc.property(schemaKindArb, fc.array(mixedOpArb, { minLength: 10, maxLength: steps }), (schemaKind, ops) => {
        runSequence(ops, { label: "snap-mixed", schemaKind, finalizeCommit: true });
      }),
      fuzzAssertConfig(12),
    );
  });

  test("SNP-prop-01: restore is idempotent on probe results", () => {
    fc.assert(
      fc.property(
        schemaKindArb,
        fc.array(fc.record({ a: intArb, b: textArb }), { minLength: 1, maxLength: 8 }),
        (schemaKind, rows) => {
          const memory = new InMemoryAdapter();
          try {
            memory.exec(schemaFor(schemaKind));
            for (const [i, row] of rows.entries()) {
              memory.exec(`INSERT INTO t(id, a, b) VALUES (${i + 1}, ${row.a}, '${row.b.replaceAll("'", "''")}')`);
            }
            const state = initialSimState(schemaKind);
            const probes = probesForState(state);
            const before = captureProbeResults(memory, probes);
            const snap = memory.snapshot();
            memory.restore(snap);
            memory.restore(snap);
            const after = captureProbeResults(memory, probes);
            assertProbeResultsEqual("idempotent-restore", before, after);
          } finally {
            memory.close();
          }
        },
      ),
      fuzzAssertConfig(12),
    );
  });

  test("SNP-prop-02: insert-then-delete preserves probe results before restore", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ a: intArb, b: safeTextArb }), { minLength: 1, maxLength: 6 }), (rows) => {
        const memory = new InMemoryAdapter();
        try {
          memory.exec(schemaFor("plain"));
          for (const [i, row] of rows.entries()) {
            memory.exec(`INSERT INTO t(id, a, b) VALUES (${i + 1}, ${row.a}, '${row.b.replaceAll("'", "''")}')`);
          }
          const probes = probesForState(initialSimState("plain"));
          const before = captureProbeResults(memory, probes);
          const snap = memory.snapshot();
          const tmpId = rows.length + 99;
          memory.exec(`INSERT INTO t(id, a, b) VALUES (${tmpId}, 0, 'tmp')`);
          memory.exec(`DELETE FROM t WHERE id = ${tmpId}`);
          assertProbeResultsEqual("insert-delete", before, captureProbeResults(memory, probes));
          memory.restore(snap);
          assertProbeResultsEqual("after-restore", before, captureProbeResults(memory, probes));
          memory.restore(snap);
          void snap;
        } finally {
          memory.close();
        }
      }),
      fuzzAssertConfig(12),
    );
  });

  test("SNP-prop-03: indexed and full scans agree after snapshot restore", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.integer({ min: 1, max: 12 }), v: intArb, flag: fc.integer({ min: 0, max: 1 }) }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.integer({ min: -20, max: 20 }),
        (rows, probe) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v INT, flag INT)");
              db.exec("CREATE INDEX idx_partial ON t(v) WHERE flag = 1");
              db.exec("CREATE INDEX idx_expr ON t(v + 1)");
              for (const row of rows) {
                db.exec("INSERT INTO t VALUES (?, ?, ?)", [row.id, row.v, row.flag]);
              }
            }
            const probes = [
              `SELECT id, v, flag FROM t WHERE flag = 1 AND v = ${probe} ORDER BY id`,
              `SELECT id, v FROM t WHERE v + 1 = ${probe + 1} ORDER BY id`,
              "SELECT id, v, flag FROM t ORDER BY id",
            ];
            runSnapshotCheckpoint(memory, probes);
            for (const sql of probes) {
              compareOrReport("index-post-restore", sql, { rows, probe }, memory.query(sql), sqlite.query(sql));
            }
          });
        },
      ),
      fuzzAssertConfig(16),
    );
  });

  test("Snapshot.open() CoW forks preserve independent probe results", () => {
    fc.assert(
      fc.property(intArb, textArb, (a, b) => {
        const db = new Database({ seed: 1 });
        try {
          db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)");
          db.exec("INSERT INTO t VALUES (1, 10, 'x')");
          const before = db.query("SELECT id, a, b FROM t ORDER BY id");
          const snap = db.snapshot();
          const child = snap.open();
          child.exec(`INSERT INTO t VALUES (2, ${a}, '${b.replaceAll("'", "''")}')`);
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

  test("FK parent/child probes survive snapshot restore", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 5 }), (pid, cid) => {
        const memory = new InMemoryAdapter();
        try {
          memory.exec("PRAGMA foreign_keys = ON");
          memory.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY)");
          memory.exec(
            "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE)",
          );
          memory.exec(`INSERT INTO parent(id) VALUES (${pid})`);
          memory.exec(`INSERT INTO child(id, parent_id) VALUES (${cid}, ${pid})`);
          const probes = [
            "SELECT id FROM parent ORDER BY id",
            "SELECT id, parent_id FROM child ORDER BY id",
            "SELECT c.id FROM child c JOIN parent p ON c.parent_id = p.id ORDER BY c.id",
          ];
          runSnapshotCheckpoint(memory, probes, { destructiveSql: "DELETE FROM child" });
        } finally {
          memory.close();
        }
      }),
      fuzzAssertConfig(12),
    );
  });

  test("double decode yields identical probe results", () => {
    const db = new Database({ seed: 99 });
    try {
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT)");
      db.exec("CREATE VIEW v AS SELECT id, a FROM t");
      db.exec("INSERT INTO t VALUES (1, 2)");
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
