import { describe, expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { PRAGMA_TVF_NAMES } from "../../../src/executor/pragma-engine.ts";
import { expectParity, matrixBoth } from "../../harness/index.ts";
import { parity } from "../helpers.ts";

describe("pragma_* TVFs", () => {
  parity(
    "pragma_table_info TVF matches statement form vs oracle",
    ["CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT 'x')"],
    "SELECT * FROM pragma_table_info('people') ORDER BY cid",
  );

  // Kysely SqliteIntrospector style: correlated TVF arg from outer CTE/subquery row.
  parity(
    "correlated pragma_table_info(tl.name) comma-join",
    ["CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT)", "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)"],
    `WITH table_list AS (
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    )
    SELECT
      tl.name AS "table",
      p.cid, p.name, p.type, p."notnull", p.dflt_value, p.pk
    FROM table_list AS tl, pragma_table_info(tl.name) AS p
    ORDER BY tl.name, p.cid`,
  );

  parity(
    "correlated pragma_table_info(tl.name) JOIN",
    ["CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT)", "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)"],
    `SELECT tl.name AS "table", p.name
     FROM (SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%') AS tl
     JOIN pragma_table_info(tl.name) AS p
     ORDER BY tl.name, p.cid`,
  );

  parity(
    "correlated pragma_table_info empty catalog returns empty",
    [],
    `WITH table_list AS (
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    )
    SELECT tl.name AS "table", p.name
    FROM table_list AS tl, pragma_table_info(tl.name) AS p
    ORDER BY tl.name, p.name`,
  );

  parity(
    "correlated pragma_index_list(tl.name)",
    ["CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT)", "CREATE INDEX idx_people_name ON people(name)"],
    `SELECT tl.name AS "table", p.name, p."unique"
     FROM (SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'people') AS tl
     JOIN pragma_index_list(tl.name) AS p
     ORDER BY p.seq`,
  );

  parity(
    "correlated pragma_table_xinfo(tl.name)",
    ["CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT NOT NULL)"],
    `SELECT tl.name AS "table", p.name, p.hidden
     FROM (SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'people') AS tl
     JOIN pragma_table_xinfo(tl.name) AS p
     ORDER BY p.cid`,
  );

  parity(
    "pragma_table_xinfo TVF",
    ["CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT NOT NULL)"],
    "SELECT * FROM pragma_table_xinfo('people') ORDER BY cid",
  );

  parity("pragma_database_list bare TVF", [], "SELECT * FROM pragma_database_list");

  parity("pragma_database_list() TVF", [], "SELECT * FROM pragma_database_list()");

  parity(
    "pragma_index_list TVF",
    ["CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT)", "CREATE INDEX idx_people_name ON people(name)"],
    "SELECT * FROM pragma_index_list('people') ORDER BY seq",
  );

  matrixBoth("pragma_foreign_keys TVF", (memory, sqlite) => {
    memory.exec("PRAGMA foreign_keys = OFF");
    sqlite.exec("PRAGMA foreign_keys = OFF");
    expectParity(memory.query("SELECT * FROM pragma_foreign_keys"), sqlite.query("SELECT * FROM pragma_foreign_keys"));
  });

  parity("pragma_user_version TVF", [], "SELECT * FROM pragma_user_version");

  parity("pragma_page_size TVF matches bun memory default", [], "SELECT * FROM pragma_page_size");

  parity("pragma_journal_mode TVF", [], "SELECT * FROM pragma_journal_mode");

  parity("pragma_encoding TVF", [], "SELECT * FROM pragma_encoding");

  parity("pragma_integrity_check TVF", [], "SELECT * FROM pragma_integrity_check");

  parity("pragma_collation_list TVF", [], "SELECT * FROM pragma_collation_list ORDER BY seq");

  matrixBoth("pragma_table_list includes user tables", (memory, sqlite) => {
    memory.exec("CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT)");
    sqlite.exec("CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT)");
    expectParity(
      memory.query("SELECT schema, name, type, ncol, wr, strict FROM pragma_table_list WHERE name = 'people'"),
      sqlite.query("SELECT schema, name, type, ncol, wr, strict FROM pragma_table_list WHERE name = 'people'"),
    );
  });

  matrixBoth("pragma_foreign_key_list TVF", (memory, sqlite) => {
    const ddl = `
      CREATE TABLE parent(id INTEGER PRIMARY KEY);
      CREATE TABLE child(id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id));
    `;
    memory.exec(ddl);
    sqlite.exec(ddl);
    expectParity(
      memory.query("SELECT * FROM pragma_foreign_key_list('child') ORDER BY id, seq"),
      sqlite.query("SELECT * FROM pragma_foreign_key_list('child') ORDER BY id, seq"),
    );
  });

  matrixBoth("pragma_foreign_key_check TVF", (memory, sqlite) => {
    memory.exec("PRAGMA foreign_keys = OFF");
    sqlite.exec("PRAGMA foreign_keys = OFF");
    memory.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY)");
    memory.exec("CREATE TABLE child(id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id))");
    sqlite.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY)");
    sqlite.exec("CREATE TABLE child(id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id))");
    memory.exec("INSERT INTO child VALUES (1, 99)");
    sqlite.exec("INSERT INTO child VALUES (1, 99)");
    expectParity(
      memory.query('SELECT "table", rowid, parent, fkid FROM pragma_foreign_key_check ORDER BY "table", rowid'),
      sqlite.query('SELECT "table", rowid, parent, fkid FROM pragma_foreign_key_check ORDER BY "table", rowid'),
    );
  });

  test("all oracle pragma_* TVF names resolve", () => {
    const db = new Database();
    for (const base of PRAGMA_TVF_NAMES) {
      const name = `pragma_${base}`;
      // Names that require an argument may return empty rows; they must not throw "no such".
      try {
        if (
          base === "table_info" ||
          base === "table_xinfo" ||
          base === "index_list" ||
          base === "index_info" ||
          base === "index_xinfo" ||
          base === "foreign_key_list"
        ) {
          db.query(`SELECT * FROM ${name}('sqlite_schema')`);
        } else {
          db.query(`SELECT * FROM ${name}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).not.toMatch(/no such table-valued function/);
        expect(message).not.toMatch(/no such table/);
      }
    }
    db.close();
  });

  test("pragma_function_list exposes abs", () => {
    const db = new Database();
    const rows = db.query<{ name: string }>("SELECT name FROM pragma_function_list WHERE name = 'abs'");
    expect(rows.length).toBeGreaterThan(0);
    db.close();
  });

  test("pragma_module_list includes pragma_table_info", () => {
    const db = new Database();
    const rows = db.query<{ name: string }>("SELECT name FROM pragma_module_list WHERE name = 'pragma_table_info'");
    expect(rows).toEqual([{ name: "pragma_table_info" }]);
    db.close();
  });

  test("pragma_pragma_list is non-empty", () => {
    const db = new Database();
    const rows = db.query("SELECT name FROM pragma_pragma_list WHERE name = 'table_info'");
    expect(rows).toEqual([{ name: "table_info" }]);
    db.close();
  });
});
