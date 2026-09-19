import { expect } from "bun:test";
import { Snapshot } from "../../../src/index.ts";
import { runCatalog } from "./run.ts";

runCatalog("PRG", [
  {
    id: "PRG-ti-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT)"],
    sql: "SELECT name FROM pragma_table_info('t')",
  },
  {
    id: "PRG-idx-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT, b INT)", "CREATE INDEX i ON t(a,b)"],
    sql: "SELECT name FROM pragma_index_list('t')",
  },
  { id: "PRG-db-01", kind: "parity", sql: "SELECT name, seq FROM pragma_database_list() ORDER BY seq" },
  {
    id: "PRG-fk-01",
    kind: "parity",
    setup: ["CREATE TABLE p(id INT PRIMARY KEY)", "CREATE TABLE c(id INT REFERENCES p(id))"],
    sql: 'SELECT "table", "from" FROM pragma_foreign_key_list(\'c\')',
  },
  { id: "PRG-fn-01", kind: "parity", sql: "SELECT count(*)>10 FROM pragma_function_list()" },
  { id: "PRG-col-01", kind: "parity", sql: "SELECT name FROM pragma_collation_list() ORDER BY name" },
  {
    id: "PRG-tl-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT)"],
    sql: "SELECT name FROM pragma_table_list() WHERE schema='main' AND name='t'",
  },
  {
    id: "PRG-tvf-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT)", "CREATE TABLE u(b TEXT)"],
    sql: "SELECT tl.name, p.name FROM pragma_table_list() AS tl, pragma_table_info(tl.name) AS p WHERE tl.schema='main' AND tl.name IN ('t','u') ORDER BY tl.name, p.cid",
  },
  {
    id: "PRG-beh-01",
    kind: "sequence",
    steps: [
      { sql: "PRAGMA foreign_keys", query: true },
      { sql: "PRAGMA foreign_keys=OFF" },
      { sql: "PRAGMA foreign_keys", query: true },
      { sql: "PRAGMA foreign_keys=ON" },
      { sql: "PRAGMA foreign_keys", query: true },
    ],
  },
  {
    id: "PRG-beh-02",
    kind: "divergence",
    fn: (db) => {
      // Setter is accepted; engine currently keeps defer_foreign_keys at 0 (read path proven).
      db.exec("PRAGMA defer_foreign_keys=ON");
      expect(db.query("PRAGMA defer_foreign_keys")).toEqual([{ defer_foreign_keys: 0 }]);
    },
  },
  {
    id: "PRG-beh-03",
    kind: "divergence",
    fn: (db) => {
      db.exec("PRAGMA recursive_triggers=ON");
      expect(db.query("PRAGMA recursive_triggers")).toEqual([{ recursive_triggers: 0 }]);
    },
  },
  {
    id: "PRG-beh-04",
    kind: "sequence",
    steps: [
      { sql: "SELECT 'a' LIKE 'A' AS ci", query: true },
      { sql: "PRAGMA case_sensitive_like=1" },
      { sql: "SELECT 'a' LIKE 'A' AS miss, 'A' LIKE 'A' AS hit", query: true },
      { sql: "PRAGMA case_sensitive_like=0" },
      { sql: "SELECT 'a' LIKE 'A' AS ci_again", query: true },
    ],
  },
  {
    id: "PRG-beh-05",
    kind: "divergence",
    fn: (db) => {
      db.exec("PRAGMA user_version=7");
      expect(db.query("PRAGMA user_version")).toEqual([{ user_version: 7 }]);
      const other = Snapshot.decode(db.snapshot().encode()).open();
      expect(other.query("PRAGMA user_version")).toEqual([{ user_version: 0 }]);
      other.close();
    },
  },
  {
    id: "PRG-beh-06",
    kind: "sequence",
    steps: [
      { sql: "PRAGMA schema_version", query: true },
      { sql: "CREATE TABLE t(a INT)" },
      { sql: "PRAGMA schema_version", query: true },
    ],
  },
  {
    id: "PRG-beh-07",
    kind: "divergence",
    fn: (db) => {
      db.exec("PRAGMA application_id=42");
      expect(db.query("PRAGMA application_id")).toEqual([{ application_id: 0 }]);
    },
  },
  { id: "PRG-health-01", kind: "parity", sql: "PRAGMA integrity_check" },
  {
    id: "PRG-health-02",
    kind: "parity",
    setup: ["CREATE TABLE p(id INT PRIMARY KEY)", "CREATE TABLE c(id INT REFERENCES p(id))"],
    sql: "PRAGMA foreign_key_check",
  },
  { id: "PRG-stor-01", kind: "parity", sql: "PRAGMA journal_mode" },
  { id: "PRG-stor-02", kind: "parity", sql: "PRAGMA encoding" },
  { id: "PRG-unk-01", kind: "parity", sql: "PRAGMA not_a_real_pragma" },
  { id: "PRG-schema-01", kind: "parity", sql: "PRAGMA encoding" },
  { id: "PRG-comp-01", kind: "parity", sql: "SELECT count(*)>0 FROM pragma_compile_options()" },
]);
