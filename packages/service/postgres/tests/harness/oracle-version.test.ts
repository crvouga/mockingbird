import { describe, expect, test } from "bun:test";
import { createOracleAdapter, oracleKind } from "./oracle.ts";
import { SUPPORTED_ORACLE_VERSIONS } from "./oracle-versions.ts";

/** Strip trailing build suffixes ("18.3 (Debian …)" → "18.3"). */
function normalizeServerVersion(raw: string): string {
  const token = raw.trim().split(/\s+/u)[0] ?? raw.trim();
  const m = /^(\d+\.\d+)/u.exec(token);
  return m?.[1] ?? token;
}

describe("oracle version pin", () => {
  test(`${oracleKind()} server_version is on the allow-list`, async () => {
    const db = createOracleAdapter();
    try {
      const res = await db.query("SELECT current_setting('server_version') AS v");
      expect(res.ok).toBe(true);
      const version = normalizeServerVersion(String(res.values[0]?.[0] ?? ""));
      expect(SUPPORTED_ORACLE_VERSIONS as readonly string[]).toContain(version);
    } finally {
      await db.close();
    }
  });
});
