import { parity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "search_path picks the first schema containing the table",
  [
    "CREATE SCHEMA a",
    "CREATE SCHEMA b",
    "CREATE TABLE a.t (v text)",
    "CREATE TABLE b.t (v text)",
    "INSERT INTO a.t VALUES ('a')",
    "INSERT INTO b.t VALUES ('b')",
  ],
  [
    { sql: "SET search_path TO a, b" },
    { sql: "SELECT v FROM t", query: true },
    { sql: "SET search_path TO b, a" },
    { sql: "SELECT v FROM t", query: true },
  ],
);

sequenceParity(
  "unqualified resolution falls through schemas missing the table",
  ["CREATE SCHEMA a", "CREATE SCHEMA b", "CREATE TABLE b.only_b (v text)", "INSERT INTO b.only_b VALUES ('found')"],
  [{ sql: "SET search_path TO a, b" }, { sql: "SELECT v FROM only_b", query: true }],
);

sequenceParity(
  "CREATE TABLE goes to the first schema on the search_path",
  ["CREATE SCHEMA a"],
  [
    { sql: "SET search_path TO a, public" },
    { sql: "CREATE TABLE created_here (id int)" },
    {
      sql: "SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid WHERE c.relname = 'created_here'",
      query: true,
    },
  ],
);

sequenceParity(
  "current_schema reflects the first search_path entry",
  ["CREATE SCHEMA a"],
  [
    { sql: "SELECT current_schema() AS v", query: true },
    { sql: "SET search_path TO a, public" },
    { sql: "SELECT current_schema() AS v", query: true },
  ],
);

sequenceParity(
  "current_schemas lists the effective path",
  ["CREATE SCHEMA a", "CREATE SCHEMA b"],
  [{ sql: "SET search_path TO a, b, public" }, { sql: "SELECT current_schemas(false) AS v", query: true }],
);

sequenceParity(
  "SHOW search_path echoes what was set",
  ["CREATE SCHEMA a"],
  [{ sql: "SET search_path TO a, public" }, { sql: "SHOW search_path", query: true }],
);

sequenceParity(
  "SET search_path with a single schema",
  ["CREATE SCHEMA solo", "CREATE TABLE solo.t (id int)", "INSERT INTO solo.t VALUES (1)"],
  [
    { sql: "SET search_path TO solo" },
    { sql: "SELECT * FROM t", query: true },
    { sql: "SELECT current_schema() AS v", query: true },
  ],
);

parity("current_schema defaults to public", [], "SELECT current_schema() AS v");

sequenceParity(
  "qualified names bypass the search_path",
  [
    "CREATE SCHEMA a",
    "CREATE TABLE a.t (v text)",
    "INSERT INTO a.t VALUES ('qualified')",
    "CREATE TABLE t (v text)",
    "INSERT INTO t VALUES ('public')",
  ],
  [
    { sql: "SET search_path TO public" },
    { sql: "SELECT v FROM a.t", query: true },
    { sql: "SELECT v FROM t", query: true },
  ],
);
