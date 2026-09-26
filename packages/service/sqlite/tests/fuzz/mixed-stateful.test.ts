import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { Database } from "../../src/index.ts";
import { fuzzAssertConfig } from "./config.ts";
import { mixedOpArb, runSequence, schemaKindArb } from "./dst/index.ts";

const ciSteps = Number(process.env.SQLITE_MEM_MIXED_STEPS ?? "24");

describe("mixed DDL/DML/txn/PRAGMA stateful simulation", () => {
  test("interleaved ops match B-tuple + Dump after every step", () => {
    fc.assert(
      fc.property(schemaKindArb, fc.array(mixedOpArb, { minLength: 8, maxLength: ciSteps }), (schemaKind, ops) => {
        runSequence(ops, { label: "mixed", schemaKind, finalizeCommit: true });
      }),
      fuzzAssertConfig(16),
    );
  });
});

describe("snapshot mid-sequence property", () => {
  test("SQLM snapshot/restore preserves ordinary table state", () => {
    const db = new Database({ seed: 42 });
    try {
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)");
      db.exec("INSERT INTO t VALUES (1, 10, 'x'), (2, 20, 'y')");
      db.exec("BEGIN");
      db.exec("INSERT INTO t VALUES (3, 30, 'z')");
      db.exec("SAVEPOINT sp1");
      db.exec("UPDATE t SET a = 99 WHERE id = 1");
      db.exec("RELEASE sp1");
      db.exec("COMMIT");
      db.exec("CREATE INDEX t_a ON t(a)");
      db.exec("PRAGMA foreign_keys = ON");

      const before = db.query("SELECT id, a, b FROM t ORDER BY id");
      const snap = db.snapshot();
      db.exec("DELETE FROM t");
      expect(db.query("SELECT count(*) AS n FROM t")).toEqual([{ n: 0 }]);
      const opened = snap.open();
      expect(opened.query("SELECT id, a, b FROM t ORDER BY id")).toEqual(before);
      opened.close();
    } finally {
      db.close();
    }
  });
});
