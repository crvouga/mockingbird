import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "SET LOCAL search_path reverts after COMMIT",
  ["CREATE SCHEMA aa"],
  [
    { sql: "BEGIN" },
    { sql: "SET LOCAL search_path TO aa" },
    { sql: "SELECT current_schema() AS v", query: true },
    { sql: "COMMIT" },
    { sql: "SELECT current_schema() AS v", query: true },
  ],
);

sequenceParity(
  "SET LOCAL search_path reverts after ROLLBACK",
  ["CREATE SCHEMA aa"],
  [
    { sql: "BEGIN" },
    { sql: "SET LOCAL search_path TO aa" },
    { sql: "SELECT current_schema() AS v", query: true },
    { sql: "ROLLBACK" },
    { sql: "SELECT current_schema() AS v", query: true },
  ],
);

sequenceParity(
  "SET search_path inside a rolled-back transaction reverts",
  ["CREATE SCHEMA aa"],
  [
    { sql: "SET search_path TO public" },
    { sql: "BEGIN" },
    { sql: "SET search_path TO aa" },
    { sql: "SELECT current_schema() AS v", query: true },
    { sql: "ROLLBACK" },
    { sql: "SELECT current_schema() AS v", query: true },
  ],
);

sequenceParity(
  "SET search_path inside a committed transaction persists",
  ["CREATE SCHEMA aa"],
  [
    { sql: "BEGIN" },
    { sql: "SET search_path TO aa" },
    { sql: "COMMIT" },
    { sql: "SELECT current_schema() AS v", query: true },
  ],
);

sequenceParity(
  "RESET search_path returns to the default resolution",
  ["CREATE SCHEMA aa", "CREATE TABLE t (v text)", "INSERT INTO t VALUES ('public row')"],
  [
    { sql: "SET search_path TO aa" },
    { sql: "RESET search_path" },
    { sql: "SELECT v FROM t", query: true },
    { sql: "SELECT current_schema() AS v", query: true },
  ],
);

sequenceParity(
  "search_path change affects subsequent unqualified DML",
  ["CREATE SCHEMA a", "CREATE TABLE a.t (v text)", "CREATE TABLE t (v text)"],
  [
    { sql: "SET search_path TO a, public" },
    { sql: "INSERT INTO t VALUES ('goes to a')" },
    { sql: "SET search_path TO public" },
    { sql: "INSERT INTO t VALUES ('goes to public')" },
    { sql: "SELECT v FROM a.t", query: true },
    { sql: "SELECT v FROM public.t", query: true },
  ],
);
