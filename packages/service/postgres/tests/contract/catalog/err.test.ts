import { ERR_SECTION } from "../../../compat/sections/err.ts";
import { runCatalog } from "./run.ts";

runCatalog(ERR_SECTION, [
  {
    id: "ERR-syn-01",
    kind: "error",
    sql: "SELEC 1",
    query: true,
    notes: "42601 message wording differs: memory appends parser hints (see session-system.md)",
  },
  { id: "ERR-tab-01", kind: "error", sql: "SELECT * FROM missing_table", query: true, messageTier: "A" },
  {
    id: "ERR-col-01",
    kind: "error",
    setup: ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
    sql: "SELECT nope FROM t",
    query: true,
    messageTier: "A",
  },
  { id: "ERR-fn-01", kind: "error", sql: "SELECT no_such_fn()", query: true, messageTier: "A" },
  { id: "ERR-div-01", kind: "error", sql: "SELECT 1/0", query: true, messageTier: "A" },
  { id: "ERR-text-01", kind: "error", sql: "SELECT 'abc'::int", query: true, messageTier: "A" },
  {
    id: "ERR-uniq-01",
    kind: "error",
    setup: ["CREATE TABLE t (id int PRIMARY KEY)", "INSERT INTO t VALUES (1)"],
    sql: "INSERT INTO t VALUES (1)",
    messageTier: "A",
  },
  {
    id: "ERR-null-01",
    kind: "error",
    setup: ["CREATE TABLE t (id int NOT NULL)"],
    sql: "INSERT INTO t VALUES (NULL)",
    messageTier: "A",
  },
  {
    id: "ERR-check-01",
    kind: "error",
    setup: ["CREATE TABLE t (id int CHECK (id > 0))"],
    sql: "INSERT INTO t VALUES (-1)",
    messageTier: "A",
  },
  { id: "ERR-range-01", kind: "error", sql: "SELECT 2147483647::int + 1", query: true, messageTier: "A" },
  {
    id: "ERR-state-01",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
    steps: [
      { sql: "SELECT * FROM missing_table", query: true },
      { sql: "SELECT * FROM t", query: true },
      { sql: "SELECT 1/0", query: true },
      { sql: "SELECT count(*) AS n FROM t", query: true },
    ],
  },
  {
    id: "ERR-state-02",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int PRIMARY KEY)", "INSERT INTO t VALUES (1)"],
    steps: [
      { sql: "INSERT INTO t VALUES (1)" },
      { sql: "INSERT INTO t VALUES (2)" },
      { sql: "SELECT * FROM t ORDER BY id", query: true },
    ],
  },
]);
