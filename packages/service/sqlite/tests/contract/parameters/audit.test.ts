import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { parity, sequenceParity, setupBoth } from "../helpers.ts";

parity(
  "prepared statement binds NULL and BLOB",
  ["CREATE TABLE t(id INTEGER, b BLOB, n INT)"],
  "SELECT typeof(?) a, typeof(?) b, hex(?) c",
  [null, new Uint8Array([1, 2]), new Uint8Array([1, 2])],
);

sequenceParity(
  "statement reuse after schema-compatible writes",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)"],
  [
    { sql: "INSERT INTO t(name) VALUES (?)", params: ["a"] },
    { sql: "INSERT INTO t(name) VALUES (?)", params: ["b"] },
    { sql: "SELECT id, name FROM t ORDER BY id", query: true },
  ],
);

matrixBoth("large integer parameter roundtrips within safe integer range", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(v INTEGER)"]);
  // bun:sqlite coerces unbound BigInt beyond Number.MAX_SAFE_INTEGER unless safeIntegers is enabled.
  // Stay inside the shared safe range for differential parity.
  const value = 9007199254740991n; // Number.MAX_SAFE_INTEGER
  expectParity(memory.exec("INSERT INTO t VALUES (?)", [value]), sqlite.exec("INSERT INTO t VALUES (?)", [value]));
  expectParity(memory.query("SELECT v, typeof(v) kind FROM t"), sqlite.query("SELECT v, typeof(v) kind FROM t"));
});
