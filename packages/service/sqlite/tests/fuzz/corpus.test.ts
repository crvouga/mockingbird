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

describe("O3 corpus regressions", () => {
  test("replay committed SQL scripts against both engines", () => {
    const files = readdirSync(dir).filter((name) => name.endsWith(".sql"));
    for (const file of files) {
      const sql = readFileSync(join(dir, file), "utf8");
      const statements = sql
        .split(";")
        .map((part) => part.replace(/--[^\n]*/g, "").trim())
        .filter(Boolean);
      withDatabases((memory, sqlite) => {
        for (const stmt of statements) {
          const isQuery = /^\s*SELECT\b/i.test(stmt);
          const isTxnOrPragma = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA)\b/i.test(stmt);
          if (isQuery) {
            compareOrReport(`corpus:${file}`, stmt, file, memory.query(stmt), sqlite.query(stmt));
          } else if (isTxnOrPragma) {
            compareOutcomeOrReport(`corpus:${file}`, stmt, file, memory.exec(stmt), sqlite.exec(stmt));
          } else {
            compareWriteOrReport(`corpus:${file}`, stmt, file, memory.exec(stmt), sqlite.exec(stmt));
          }
        }
        compareStateOrReport(`corpus-dump:${file}`, file, memory, sqlite);
      });
    }
  });
});
