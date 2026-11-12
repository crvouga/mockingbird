import { afterAll, beforeAll, expect, test } from "bun:test";
import pg from "pg";
import { type PostgresServer, serve } from "../../src/wire/index.ts";

// Issues #673–#691 were reported through a `pg` client, which sends JavaScript numbers, strings and
// arrays as untyped parameters. The SQL behavior is proven against the oracle in
// tests/contract/regressions/issue-expressions-673-691.test.ts; this pins it over the wire.

let server: PostgresServer;
let client: pg.Client;

beforeAll(async () => {
  server = await serve({ port: 0 });
  client = new pg.Client({ connectionString: server.connectionString });
  await client.connect();
});

afterAll(async () => {
  await client.end();
  await server.close();
});

const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;

test("#673 an aggregate inside an expression over an empty grouped result", async () => {
  await client.query("CREATE TABLE agg (x int, y int, b bigint)");
  expect(await rows("SELECT y, max(x) + 0 AS m FROM agg GROUP BY y")).toEqual([]);
  expect(await rows("SELECT y, coalesce(sum(b), 0) AS m FROM agg GROUP BY y")).toEqual([]);
  await client.query("CREATE VIEW agg_v AS SELECT y, greatest(max(x), 0) AS m FROM agg GROUP BY y");
  expect(await rows("SELECT count(*)::int AS n FROM agg_v")).toEqual([{ n: 0 }]);
});

test("#674 named arguments bind by name", async () => {
  await client.query(
    "CREATE FUNCTION named_f(a int DEFAULT 1, b int DEFAULT 2) RETURNS int LANGUAGE sql AS $$ SELECT a * 10 + b $$",
  );
  expect(await rows("SELECT named_f(b => 5) AS v, named_f(b => 5, a => 7) AS w")).toEqual([{ v: 15, w: 75 }]);
});

test("#675 LIKE ANY over an array parameter", async () => {
  expect(await rows("SELECT 'abc' LIKE ANY($1::text[]) AS v", [["a%"]])).toEqual([{ v: true }]);
  expect(await rows("SELECT 'abc' NOT ILIKE ALL($1::text[]) AS v", [["Z%"]])).toEqual([{ v: true }]);
});

test("#676 an untyped parameter times an interval", async () => {
  expect(await rows("SELECT ($1 * interval '1 day')::text AS v", [2])).toEqual([{ v: "2 days" }]);
  expect(await rows("SELECT (interval '1 hour' * $1)::text AS v", [3])).toEqual([{ v: "03:00:00" }]);
  expect(await rows("SELECT (interval '1 hour' / $1)::text AS v", [2])).toEqual([{ v: "00:30:00" }]);
});

test("#687 a row constructor IN a two-column unnest of array parameters", async () => {
  await client.query("CREATE TABLE pairs (x int, y int)");
  await client.query("INSERT INTO pairs VALUES (1, 1), (2, 1), (3, 2)");
  expect(
    await rows("SELECT x FROM pairs WHERE (x, y) IN (SELECT * FROM unnest($1::int[], $2::int[])) ORDER BY 1", [
      [1, 3],
      [1, 2],
    ]),
  ).toEqual([{ x: 1 }, { x: 3 }]);
});

test("#688 generate_series over dates in the select list", async () => {
  expect(
    await rows("SELECT generate_series(date '2026-01-01', date '2026-03-01', interval '1 month')::date::text AS m"),
  ).toEqual([{ m: "2026-01-01" }, { m: "2026-02-01" }, { m: "2026-03-01" }]);
});

test("#691 void results are not NULL", async () => {
  expect(await rows("SELECT pg_sleep(0) IS NOT NULL AS v")).toEqual([{ v: true }]);
});
