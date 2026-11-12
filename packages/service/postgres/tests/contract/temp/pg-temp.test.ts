import { sequenceParity } from "../helpers.ts";

// #685: pg_temp names the session's temporary schema

sequenceParity(
  "temporary relations resolve through pg_temp",
  [],
  [
    { sql: "CREATE TEMP VIEW pgt_v AS SELECT 1 AS a" },
    { sql: "CREATE TEMP TABLE pgt_t (a int)" },
    { sql: "SELECT a FROM pgt_v", query: true },
    { sql: "SELECT a FROM pg_temp.pgt_v", query: true },
    { sql: "INSERT INTO pg_temp.pgt_t VALUES (1)" },
    { sql: "SELECT count(*)::int AS n FROM pg_temp.pgt_t", query: true },
    { sql: "SELECT 'pg_temp.pgt_v'::regclass IS NOT NULL AS resolved", query: true },
    { sql: "SELECT to_regclass('pg_temp.pgt_v') IS NOT NULL AS resolved", query: true },
    { sql: "SELECT to_regclass('pg_temp.pgt_missing') IS NULL AS missing", query: true },
    { sql: "SELECT pg_get_viewdef('pg_temp.pgt_v'::regclass) IS NOT NULL AS has_definition", query: true },
    { sql: "CREATE VIEW pgt_public_v AS SELECT 1 AS a" },
    {
      sql: "SELECT pg_get_viewdef('pg_temp.pgt_v'::regclass) = pg_get_viewdef(to_regclass('public.pgt_public_v')) AS same_definition",
      query: true,
    },
    // a permanent relation is not in pg_temp
    { sql: "SELECT a FROM pg_temp.pgt_public_v", query: true },
    // the oracle's temporary schema outlives the test
    { sql: "DROP VIEW pg_temp.pgt_v" },
    { sql: "DROP TABLE pgt_t" },
  ],
);
