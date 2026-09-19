import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig } from "./config.ts";
import { compareOrReport, compareOutcomeOrReport, withDatabases } from "./helpers.ts";

const opArb = fc.record({
  kind: fc.constantFrom("insert_parent", "insert_child", "delete_parent", "delete_child"),
  id: fc.integer({ min: 1, max: 8 }),
  parentId: fc.integer({ min: 1, max: 8 }),
});

describe("foreign key differential fuzz", () => {
  test("random FK insert and delete outcomes match SQLite", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 4, maxLength: 14 }), (operations) => {
        withDatabases((memory, sqlite) => {
          for (const db of [memory, sqlite]) {
            db.exec("PRAGMA foreign_keys=ON");
            db.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY)");
            db.exec(
              "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE)",
            );
          }

          for (const [index, op] of operations.entries()) {
            const sql =
              op.kind === "insert_parent"
                ? `INSERT INTO parent(id) VALUES (${op.id})`
                : op.kind === "insert_child"
                  ? `INSERT INTO child(id, parent_id) VALUES (${op.id}, ${op.parentId})`
                  : op.kind === "delete_parent"
                    ? `DELETE FROM parent WHERE id = ${op.id}`
                    : `DELETE FROM child WHERE id = ${op.id}`;
            compareOutcomeOrReport(`fk-${op.kind}`, sql, { operations, index }, memory.exec(sql), sqlite.exec(sql));
          }

          const parents = "SELECT id FROM parent ORDER BY id";
          const children = "SELECT id, parent_id FROM child ORDER BY id";
          compareOrReport("fk-parents", parents, operations, memory.query(parents), sqlite.query(parents));
          compareOrReport("fk-children", children, operations, memory.query(children), sqlite.query(children));
        });
      }),
      fuzzAssertConfig(30),
    );
  });

  test("SET NULL SET DEFAULT and MATCH edges match SQLite", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("SET NULL", "SET DEFAULT", "CASCADE"),
        fc.constantFrom("SIMPLE", "FULL"),
        fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 2, maxLength: 8 }),
        (onDelete, match, ids) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("PRAGMA foreign_keys=ON");
              db.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY)");
              db.exec(
                `CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER DEFAULT 1, FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE ${onDelete} MATCH ${match})`,
              );
              db.exec("INSERT INTO parent(id) VALUES (1)");
            }

            for (const [i, id] of ids.entries()) {
              compareOutcomeOrReport(
                "fk-edge-ins",
                `INSERT INTO child(id, parent_id) VALUES (${i + 10}, ${id})`,
                { onDelete, match, id },
                memory.exec(`INSERT INTO child(id, parent_id) VALUES (${i + 10}, ${id})`),
                sqlite.exec(`INSERT INTO child(id, parent_id) VALUES (${i + 10}, ${id})`),
              );
            }
            compareOutcomeOrReport(
              "fk-edge-del",
              "DELETE FROM parent WHERE id = 1",
              { onDelete, match },
              memory.exec("DELETE FROM parent WHERE id = 1"),
              sqlite.exec("DELETE FROM parent WHERE id = 1"),
            );
            const children = "SELECT id, parent_id FROM child ORDER BY id";
            compareOrReport(
              "fk-edge-children",
              children,
              { onDelete, match, ids },
              memory.query(children),
              sqlite.query(children),
            );
          });
        },
      ),
      fuzzAssertConfig(20),
    );
  });

  test("composite MATCH SIMPLE and FULL with NULL children match SQLite", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("SIMPLE", "FULL"),
        fc.array(
          fc.record({
            id: fc.integer({ min: 10, max: 30 }),
            a: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 3 })),
            b: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 3 })),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        (match, children) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("PRAGMA foreign_keys=ON");
              db.exec("CREATE TABLE parent(a INTEGER, b INTEGER, PRIMARY KEY(a,b))");
              db.exec(
                `CREATE TABLE child(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b) MATCH ${match})`,
              );
              db.exec("INSERT INTO parent VALUES (1,1),(2,2),(3,3)");
            }
            for (const [index, row] of children.entries()) {
              const a = row.a === null ? "NULL" : String(row.a);
              const b = row.b === null ? "NULL" : String(row.b);
              const sql = `INSERT INTO child(id, a, b) VALUES (${row.id}, ${a}, ${b})`;
              compareOutcomeOrReport(
                "fk-match-ins",
                sql,
                { match, children, index },
                memory.exec(sql),
                sqlite.exec(sql),
              );
            }
            const select = "SELECT id, a, b FROM child ORDER BY id";
            compareOrReport("fk-match-sel", select, { match, children }, memory.query(select), sqlite.query(select));
          });
        },
      ),
      fuzzAssertConfig(20),
    );
  });
});
