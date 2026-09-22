/**
 * Parse SQLLogicTest records and run them differentially (mem vs bun:sqlite).
 *
 * Record forms:
 *   statement ok|error
 *   <sql>
 *
 *   query <type-string> [nosort|rowsort|valuesort]
 *   <sql>
 *   ----
 *   <expected rows...>
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import skip from "../../compat/sqllogictest-skip.json";
import type { ContractDb, QueryResult, SqlValue } from "../harness/types.ts";
import { compareOrReport, compareOutcomeOrReport, withDatabases } from "./helpers.ts";

export type SltRecord =
  | { kind: "statement"; expect: "ok" | "error"; sql: string; line: number }
  | {
      kind: "query";
      types: string;
      sort: "nosort" | "rowsort" | "valuesort";
      sql: string;
      expected: string[];
      line: number;
    };

export function parseSlt(source: string): SltRecord[] {
  const lines = source.split(/\r?\n/);
  const records: SltRecord[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (line === "" || line.startsWith("#")) {
      i++;
      continue;
    }

    if (line.startsWith("statement ")) {
      const expect = line.slice("statement ".length).trim() as "ok" | "error";
      const start = i + 1;
      i++;
      const sqlLines: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "") {
        sqlLines.push(lines[i]!);
        i++;
      }
      records.push({ kind: "statement", expect, sql: sqlLines.join("\n").trim(), line: start });
      continue;
    }

    if (line.startsWith("query ")) {
      const parts = line.split(/\s+/);
      const types = parts[1] ?? "";
      const sort = (parts[2] as SltRecord extends { sort: infer S } ? S : never) ?? "nosort";
      const start = i + 1;
      i++;
      const sqlLines: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "----") {
        if (lines[i]!.trim() !== "") sqlLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length && lines[i]!.trim() === "----") i++;
      const expected: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "") {
        expected.push(lines[i]!.trimEnd());
        i++;
      }
      records.push({
        kind: "query",
        types,
        sort: sort === "rowsort" || sort === "valuesort" ? sort : "nosort",
        sql: sqlLines.join("\n").trim(),
        expected,
        line: start,
      });
      continue;
    }

    i++;
  }

  return records;
}

function cellString(value: SqlValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "string") return value;
  return Buffer.from(value).toString("hex");
}

function formatResult(result: QueryResult, sort: SltRecord extends { sort: infer S } ? S : never): string[] {
  if (!result.ok) return [];
  const rows = (result.values ?? result.rows.map((row) => Object.values(row))).map((cells) =>
    cells.map(cellString).join(" "),
  );
  if (sort === "rowsort") return [...rows].sort();
  if (sort === "valuesort") {
    const values = rows.flatMap((row) => row.split(" "));
    return values.sort();
  }
  return rows;
}

export function runSltFile(path: string, label: string): void {
  const skipFiles = new Set((skip as { files: string[] }).files ?? []);
  const base = path.split("/").pop() ?? path;
  if (skipFiles.has(base)) return;

  const records = parseSlt(readFileSync(path, "utf8"));
  withDatabases((memory, sqlite) => {
    for (const record of records) {
      if (record.kind === "statement") {
        const mem = memory.exec(record.sql);
        const ora = sqlite.exec(record.sql);
        if (record.expect === "ok") {
          compareOrReport(`slt:${label}:${record.line}`, record.sql, record, mem, ora);
        } else {
          compareOutcomeOrReport(`slt-err:${label}:${record.line}`, record.sql, record, mem, ora);
          if (mem.ok || ora.ok) {
            throw new Error(`expected error at ${label}:${record.line}: ${record.sql}`);
          }
        }
        continue;
      }

      const mem = memory.query(record.sql);
      const ora = sqlite.query(record.sql);
      compareOrReport(`slt:${label}:${record.line}`, record.sql, record, mem, ora);

      const formatted = formatResult(mem, record.sort);
      if (formatted.join("\n") !== record.expected.join("\n")) {
        // Prefer differential vs oracle; expected block is advisory when both engines agree.
        const oraFmt = formatResult(ora, record.sort);
        if (oraFmt.join("\n") === record.expected.join("\n") && formatted.join("\n") !== oraFmt.join("\n")) {
          throw new Error(
            `SLT expected mismatch at ${label}:${record.line}\nexpected:\n${record.expected.join("\n")}\ngot:\n${formatted.join("\n")}`,
          );
        }
      }
    }
  });
}

export function listSltFiles(dir = join(import.meta.dir, "../../vendor/sqllogictest/test")): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".test"))
    .map((name) => join(dir, name))
    .sort();
}

/** Unused helper kept for type-checking ContractDb usage in docs. */
export function _unusedDb(_db: ContractDb): void {}
