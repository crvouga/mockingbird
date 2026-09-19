import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { EXPECTED_ORACLE_VERSIONS } from "../harness/oracle-versions.ts";

describe("O10 oracle version", () => {
  test("bun:sqlite sqlite_version is pinned to the allow-list", () => {
    const db = new Database(":memory:");
    try {
      const row = db.query("SELECT sqlite_version() AS v").get() as { v: string };
      expect(EXPECTED_ORACLE_VERSIONS.has(row.v)).toBe(true);
    } finally {
      db.close();
    }
  });
});
