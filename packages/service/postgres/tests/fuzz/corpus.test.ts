import { describe, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareOrReport,
  compareOutcomeOrReport,
  compareStateOrReport,
  compareWriteOrReport,
  withDatabases,
} from "./helpers.ts";

const dir = join(import.meta.dir, "../corpus/regressions");

/**
 * Replay every committed corpus script against both engines, statement by
 * statement. Naive `split(";")` is intentional: corpus scripts must not put
 * semicolons inside string literals or dollar-quoted bodies.
 */
describe("corpus regressions", () => {
  test("replay committed SQL scripts against both engines", async () => {
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    if (files.length === 0) throw new Error(`no corpus scripts found in ${dir}`);
    for (const file of files) {
      const sql = readFileSync(join(dir, file), "utf8");
      const statements = sql
        .split(";")
        .map((part) => part.replace(/--[^\n]*/g, "").trim())
        .filter(Boolean);
      await withDatabases(async (memory, postgres) => {
        for (const stmt of statements) {
          const isQuery = /^\s*(SELECT|WITH)\b/i.test(stmt);
          const isTxnControl = /^\s*(BEGIN|START|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(stmt);
          if (isQuery) {
            compareOrReport(`corpus:${file}`, stmt, file, await memory.query(stmt), await postgres.query(stmt));
          } else if (isTxnControl) {
            compareOutcomeOrReport(`corpus:${file}`, stmt, file, await memory.exec(stmt), await postgres.exec(stmt));
          } else {
            compareWriteOrReport(`corpus:${file}`, stmt, file, await memory.exec(stmt), await postgres.exec(stmt));
          }
        }
        await compareStateOrReport(`corpus-dump:${file}`, file, memory, postgres);
      });
    }
  }, 120_000);
});
