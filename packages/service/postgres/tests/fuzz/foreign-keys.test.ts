import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOutcomeOrReport, compareStateOrReport, withDatabases } from "./helpers.ts";

/**
 * ON DELETE RESTRICT is deliberately excluded: it raises SQLSTATE 23001 in the
 * oracle but 23503 in memory (see tests/contract/_reports/dml-ddl.md).
 * All statements are single-row so multi-row atomicity cannot diverge.
 */
const actionArb = fc.constantFrom("NO ACTION", "CASCADE", "SET NULL");

const opArb = fc.record({
  kind: fc.constantFrom(
    "insert_parent",
    "insert_child",
    "delete_parent",
    "delete_child",
    "update_child",
    "update_parent",
  ),
  id: fc.integer({ min: 1, max: 6 }),
  parentId: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 6 })),
  w: intArb,
});

type FkOp = typeof opArb extends fc.Arbitrary<infer T> ? T : never;

function fkOpToSql(op: FkOp): string {
  const pid = op.parentId === null ? "NULL" : String(op.parentId);
  switch (op.kind) {
    case "insert_parent":
      return `INSERT INTO parent (id, w) VALUES (${op.id}, (${op.w}))`;
    case "insert_child":
      return `INSERT INTO child (id, pid) VALUES (${op.id}, ${pid})`;
    case "delete_parent":
      return `DELETE FROM parent WHERE id = ${op.id}`;
    case "delete_child":
      return `DELETE FROM child WHERE id = ${op.id}`;
    case "update_child":
      return `UPDATE child SET pid = ${pid} WHERE id = ${op.id}`;
    default:
      return `UPDATE parent SET w = (${op.w}) WHERE id = ${op.id}`;
  }
}

describe("foreign key differential fuzz", () => {
  test("random parent/child sequences match postgres under each FK action", async () => {
    await fc.assert(
      fc.asyncProperty(actionArb, fc.array(opArb, { minLength: 3, maxLength: 11 }), async (action, operations) => {
        await withDatabases(async (memory, postgres) => {
          for (const db of [memory, postgres]) {
            await db.exec("CREATE TABLE parent (id int PRIMARY KEY, w int)");
            await db.exec(`CREATE TABLE child (id int PRIMARY KEY, pid int REFERENCES parent(id) ON DELETE ${action})`);
          }

          for (const [index, op] of operations.entries()) {
            const sql = fkOpToSql(op);
            compareOutcomeOrReport(
              `fk-${op.kind}`,
              sql,
              { action, operations, index },
              await memory.exec(sql),
              await postgres.exec(sql),
            );
          }

          await compareStateOrReport("fk-state", { action, operations }, memory, postgres);
        });
      }),
      fuzzAssertConfig(30),
    );
  }, 240_000);
});
