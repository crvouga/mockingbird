import { expect } from "bun:test";
import { SqliteError } from "../../../src/index.ts";
import { runCatalog } from "./run.ts";

runCatalog("CON", [
  { id: "CON-nn-01", kind: "error", setup: ["CREATE TABLE t(a INT NOT NULL)"], sql: "INSERT INTO t VALUES (NULL)" },
  {
    id: "CON-uq-01",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT UNIQUE)"],
    steps: [{ sql: "INSERT INTO t VALUES (NULL),(NULL)" }, { sql: "SELECT count(*) FROM t", query: true }],
  },
  {
    id: "CON-uq-02",
    kind: "error",
    setup: ["CREATE TABLE t(a INT, b INT, UNIQUE(a,b))", "INSERT INTO t VALUES (1,2)"],
    sql: "INSERT INTO t VALUES (1,2)",
  },
  {
    id: "CON-pk-01",
    kind: "parity",
    setup: ["CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)", "INSERT INTO t(v) VALUES ('a')"],
    sql: "SELECT id FROM t",
  },
  {
    id: "CON-pk-02",
    kind: "error",
    setup: ["CREATE TABLE t(id INT PRIMARY KEY) WITHOUT ROWID"],
    sql: "INSERT INTO t VALUES (NULL)",
  },
  { id: "CON-ck-01", kind: "exec", setup: ["CREATE TABLE t(a INT CHECK (a>0))"], sql: "INSERT INTO t VALUES (NULL)" },
  {
    id: "CON-ck-02",
    kind: "error",
    setup: ["CREATE TABLE t(a INT CHECK (a>0))", "INSERT INTO t VALUES (1)"],
    sql: "UPDATE t SET a=0",
  },
  {
    id: "CON-fk-01",
    kind: "sequence",
    setup: ["CREATE TABLE p(id INT PRIMARY KEY)", "CREATE TABLE c(id INT REFERENCES p(id))"],
    steps: [
      { sql: "INSERT INTO p VALUES (1)" },
      { sql: "INSERT INTO c VALUES (1)" },
      { sql: "SELECT id FROM c", query: true },
    ],
  },
  {
    id: "CON-fk-02",
    kind: "error",
    setup: ["PRAGMA foreign_keys=ON", "CREATE TABLE p(id INT PRIMARY KEY)", "CREATE TABLE c(id INT REFERENCES p(id))"],
    sql: "INSERT INTO c VALUES (1)",
  },
  {
    id: "CON-fk-03",
    kind: "sequence",
    setup: [
      "PRAGMA foreign_keys=ON",
      "CREATE TABLE p(id INT PRIMARY KEY)",
      "CREATE TABLE c(id INT REFERENCES p(id) ON DELETE CASCADE)",
      "INSERT INTO p VALUES (1)",
      "INSERT INTO c VALUES (1)",
    ],
    steps: [{ sql: "DELETE FROM p" }, { sql: "SELECT count(*) FROM c", query: true }],
  },
  {
    id: "CON-fk-04",
    kind: "error",
    setup: [
      "PRAGMA foreign_keys=ON",
      "CREATE TABLE p(id INT PRIMARY KEY)",
      "CREATE TABLE c(id INT REFERENCES p(id) ON DELETE RESTRICT)",
      "INSERT INTO p VALUES (1)",
      "INSERT INTO c VALUES (1)",
    ],
    sql: "DELETE FROM p",
  },
  {
    id: "CON-fk-05",
    kind: "sequence",
    setup: [
      "PRAGMA foreign_keys=ON",
      "CREATE TABLE p(id INT PRIMARY KEY)",
      "CREATE TABLE c(id INT REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)",
    ],
    steps: [
      { sql: "BEGIN" },
      { sql: "INSERT INTO c VALUES (1)" },
      { sql: "INSERT INTO p VALUES (1)" },
      { sql: "COMMIT" },
      { sql: "SELECT id FROM c", query: true },
    ],
  },
  {
    id: "CON-fk-06",
    kind: "parity",
    setup: [
      "PRAGMA foreign_keys=ON",
      "CREATE TABLE t(id INT PRIMARY KEY, p INT REFERENCES t(id))",
      "INSERT INTO t VALUES (1, NULL), (2, 1)",
    ],
    sql: "SELECT id, p FROM t ORDER BY id",
  },
  {
    id: "CON-fk-07",
    kind: "error",
    setup: [
      "PRAGMA foreign_keys=ON",
      "CREATE TABLE p(a INT, b INT, PRIMARY KEY(a,b))",
      "CREATE TABLE c(a INT, b INT, FOREIGN KEY(a,b) REFERENCES p(a,b))",
    ],
    sql: "INSERT INTO c VALUES (1,2)",
  },
  {
    id: "CON-fk-08",
    kind: "sequence",
    setup: [
      "PRAGMA foreign_keys=ON",
      "CREATE TABLE p(id INT PRIMARY KEY)",
      "CREATE TABLE c(id INT PRIMARY KEY REFERENCES p(id))",
      "INSERT INTO p VALUES (1),(2)",
      "INSERT INTO c VALUES (1)",
    ],
    steps: [{ sql: "INSERT OR REPLACE INTO p VALUES (1)" }, { sql: "SELECT id FROM c", query: true }],
  },
  {
    id: "CON-fk-09",
    kind: "sequence",
    setup: [
      "PRAGMA foreign_keys=OFF",
      "CREATE TABLE p(id INT PRIMARY KEY)",
      "CREATE TABLE c(id INT REFERENCES p(id))",
      "INSERT INTO p VALUES (1)",
      "INSERT INTO c VALUES (1)",
      "INSERT INTO c VALUES (99)",
    ],
    steps: [
      { sql: "PRAGMA foreign_key_check", query: true },
      { sql: 'SELECT id, seq, "table", "from", "to" FROM pragma_foreign_key_list(\'c\')', query: true },
    ],
  },
  {
    id: "CON-err-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a INT UNIQUE)");
      db.exec("INSERT INTO t VALUES (1)");
      try {
        db.exec("INSERT INTO t VALUES (1)");
        throw new Error("expected");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteError);
        expect((error as SqliteError).sqliteCode).toBe("SQLITE_CONSTRAINT_UNIQUE");
      }
    },
  },
  {
    id: "CON-err-02",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a INT NOT NULL)");
      try {
        db.exec("INSERT INTO t VALUES (NULL)");
        throw new Error("expected");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteError);
        expect((error as SqliteError).category).toBe("constraint_notnull");
      }
    },
  },
  {
    id: "CON-err-03",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a INT CHECK (a>0))");
      try {
        db.exec("INSERT INTO t VALUES (0)");
        throw new Error("expected");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteError);
        expect((error as SqliteError).category).toBe("constraint_check");
      }
    },
  },
  {
    id: "CON-err-04",
    kind: "divergence",
    fn: (db) => {
      db.exec("PRAGMA foreign_keys=ON");
      db.exec("CREATE TABLE p(id INT PRIMARY KEY)");
      db.exec("CREATE TABLE c(id INT REFERENCES p(id))");
      try {
        db.exec("INSERT INTO c VALUES (1)");
        throw new Error("expected");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteError);
        expect((error as SqliteError).category).toBe("constraint_foreign");
      }
    },
  },
  {
    id: "CON-err-05",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a INT PRIMARY KEY)");
      db.exec("INSERT INTO t VALUES (1)");
      try {
        db.exec("INSERT INTO t VALUES (1)");
        throw new Error("expected");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteError);
        expect(["constraint_primary", "constraint_unique"]).toContain((error as SqliteError).category);
      }
    },
  },
]);
