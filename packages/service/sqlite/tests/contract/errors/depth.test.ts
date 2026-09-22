import { expect } from "bun:test";
import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { errorParity, queryErrorParity, setupBoth } from "../helpers.ts";

errorParity(
  "CHECK constraint fails on UPDATE",
  ["CREATE TABLE t(v INTEGER CHECK(v>0))", "INSERT INTO t VALUES (1)"],
  "UPDATE t SET v = -1",
  "constraint_check",
);

errorParity(
  "cannot INSERT into STORED generated column",
  ["CREATE TABLE t(a INT, b INT GENERATED ALWAYS AS (a * 2) STORED)"],
  "INSERT INTO t(a, b) VALUES (1, 99)",
  "misuse",
);

errorParity(
  "cannot INSERT into VIRTUAL generated column",
  ["CREATE TABLE t(a INT, b INT GENERATED ALWAYS AS (a * 2) VIRTUAL)"],
  "INSERT INTO t(a, b) VALUES (1, 99)",
  "misuse",
);

errorParity(
  "cannot UPDATE generated column",
  ["CREATE TABLE t(a INT, b INT GENERATED ALWAYS AS (a * 2) STORED)", "INSERT INTO t(a) VALUES (1)"],
  "UPDATE t SET b = 0",
  "misuse",
);

queryErrorParity(
  "MATCH on ordinary table is unsupported context",
  ["CREATE TABLE t(x TEXT)", "INSERT INTO t VALUES ('a')"],
  "SELECT * FROM t WHERE x MATCH 'a'",
  "unsupported",
);

matrixBoth("empty prepare/query both fail (category may differ by API)", (memory, sqlite) => {
  const a = memory.query("");
  const b = sqlite.query("");
  expect(a.ok).toBe(false);
  expect(b.ok).toBe(false);
  const ac = memory.query("-- comment only");
  const bc = sqlite.query("-- comment only");
  expect(ac.ok).toBe(false);
  expect(bc.ok).toBe(false);
});

matrixBoth("CHECK on UPDATE leaves prior row unchanged", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(v INTEGER CHECK(v>0))", "INSERT INTO t VALUES (1)"]);
  expectParity(memory.exec("UPDATE t SET v = -1"), sqlite.exec("UPDATE t SET v = -1"), {
    ignoreWriteCounters: true,
    ignoreErrorPhase: true,
    ignoreSqliteCode: true,
    messageTier: "B",
  });
  expectParity(memory.query("SELECT v FROM t"), sqlite.query("SELECT v FROM t"), {
    ignoreWriteCounters: true,
  });
});
