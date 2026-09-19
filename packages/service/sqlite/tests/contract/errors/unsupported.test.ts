import { describe, expect, test } from "bun:test";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";
import { parity } from "../helpers.ts";

describe("unsupported features", () => {
  test("MATCH on non-FTS table is unsupported", () => {
    const db = new InMemoryAdapter();
    expect(db.exec("CREATE TABLE t(content TEXT)").ok).toBe(true);
    expect(db.exec("INSERT INTO t VALUES ('x')").ok).toBe(true);
    const result = db.query("SELECT * FROM t WHERE content MATCH 'hello'");
    expect(result.ok).toBe(false);
    expect(result.error?.category).toBe("unsupported");
    db.close();
  });
});

parity(
  "INDEXED BY is accepted as a no-op",
  ["CREATE TABLE t(id INTEGER)", "CREATE INDEX idx ON t(id)", "INSERT INTO t VALUES (1)"],
  "SELECT id FROM t INDEXED BY idx",
);

parity(
  "NOT INDEXED is accepted as a no-op",
  ["CREATE TABLE t(id INTEGER)", "INSERT INTO t VALUES (1)"],
  "SELECT id FROM t NOT INDEXED",
);
