import { expect } from "bun:test";
import { expectParity, runCatching } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { errorParity, queryErrorParity } from "../helpers.ts";

queryErrorParity("missing table has no_such_table category", [], "SELECT * FROM absent", "no_such_table");
queryErrorParity(
  "missing projected column has no_such_column category",
  ["CREATE TABLE t(id INTEGER)"],
  "SELECT absent FROM t",
  "no_such_column",
);
errorParity(
  "UNIQUE failures are categorized",
  ["CREATE TABLE t(v TEXT UNIQUE)", "INSERT INTO t VALUES ('x')"],
  "INSERT INTO t VALUES ('x')",
  "constraint_unique",
);
errorParity(
  "NOT NULL failures are categorized",
  ["CREATE TABLE t(v TEXT NOT NULL)"],
  "INSERT INTO t VALUES (NULL)",
  "constraint_notnull",
);
errorParity(
  "CHECK failures are categorized",
  ["CREATE TABLE t(v INTEGER CHECK(v>0))"],
  "INSERT INTO t VALUES (0)",
  "constraint_check",
);

matrixBoth("runCatching normalizes prepare-time syntax errors", (memory, sqlite) => {
  const a = runCatching(() => memory.prepare("SELECT FROM").all());
  const b = runCatching(() => sqlite.prepare("SELECT FROM").all());
  expectParity(a, b);
  expect(a.error?.category).toBe("syntax");
  expect(b.error?.category).toBe("syntax");
});
