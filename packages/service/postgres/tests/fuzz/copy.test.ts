import { describe, test } from "bun:test";
import * as fc from "fast-check";
import type { InMemoryAdapter } from "../adapters/in-memory.ts";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

const rowArb = fc.record({
  a: intArb,
  b: fc.oneof(
    fc.constant(null),
    fc.string({ minLength: 0, maxLength: 8 }).filter((s) => !s.includes("\t") && !s.includes("\n")),
  ),
});

type Row = fc.InferValue<typeof rowArb>;

function copyText(rows: Row[]): string {
  return rows
    .map(
      (r) =>
        `${r.a}\t${r.b === null ? "\\N" : r.b.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\t", "\\t")}`,
    )
    .join("\n");
}

describe("COPY differential fuzz", () => {
  test("text COPY FROM STDIN matches multi-row INSERT on postgres", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(rowArb, { minLength: 0, maxLength: 8 }), async (rows) => {
        await withDatabases(async (memory, postgres) => {
          await memory.exec("CREATE TABLE t (a int, b text)");
          await postgres.exec("CREATE TABLE t (a int, b text)");
          if (rows.length > 0) {
            const adapter = memory as InMemoryAdapter;
            adapter.db.copyFrom("COPY t (a, b) FROM STDIN", copyText(rows));
            const tuples = rows.map((r) => `(${r.a}, ${sqlLiteral(r.b)})`).join(", ");
            await postgres.exec(`INSERT INTO t VALUES ${tuples}`);
          }
          compareOrReport(
            "copy-select",
            "SELECT a, b FROM t ORDER BY a, b NULLS FIRST",
            { rows },
            await memory.query("SELECT a, b FROM t ORDER BY a, b NULLS FIRST"),
            await postgres.query("SELECT a, b FROM t ORDER BY a, b NULLS FIRST"),
          );
        });
      }),
      fuzzAssertConfig(25),
    );
  }, 120_000);
});
