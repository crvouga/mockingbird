import { expect, test } from "bun:test";
import pg from "pg";
import { Database } from "../../src/index.ts";
import { serve } from "../../src/wire/index.ts";
import { RawClient } from "./raw-client.ts";

// #535 the hashes as advisory-lock keys, over bound parameters (advisory locks live in the wire cluster)
test("#535 hashtext / hashtextextended feed the advisory-lock functions and take bound parameters", async () => {
  const server = await serve({ database: new Database() });
  const a = new pg.Client({ connectionString: server.connectionString });
  const b = new pg.Client({ connectionString: server.connectionString });
  await a.connect();
  await b.connect();
  try {
    const bound = await a.query("SELECT hashtext($1) AS h, hashtextextended($1, $2) AS e", ["abc", "0"]);
    expect(bound.rows[0]).toEqual({ h: -785388649, e: "-6747756470228489321" });

    await a.query("BEGIN");
    await a.query("SELECT pg_advisory_xact_lock(hashtextextended('3f2c9a0e-0000-4000-8000-000000000001', 7))");
    await a.query("SELECT pg_advisory_xact_lock(hashtext('tenant-1'), 5)");
    const contended = await b.query(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, $2)) AS got, pg_try_advisory_xact_lock(hashtext($3), $4) AS got2",
      ["3f2c9a0e-0000-4000-8000-000000000001", "7", "tenant-1", 5],
    );
    expect(contended.rows[0]).toEqual({ got: false, got2: false });
    await a.query("COMMIT");
    const free = await b.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, $2)) AS got", [
      "3f2c9a0e-0000-4000-8000-000000000001",
      "7",
    ]);
    expect(free.rows[0]).toEqual({ got: true });
  } finally {
    await a.end();
    await b.end();
    await server.close();
  }
});

// #538 item 9: RowDescription carries atttypmod (the expected values are the ones PostgreSQL 18 answers)

const typmods = (body: Uint8Array): number[] => {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const out: number[] = [];
  let at = 2;
  for (let i = 0; i < view.getInt16(0); i++) {
    while (body[at] !== 0) at++;
    at += 1 + 4 + 2 + 4 + 2; // name terminator, table oid, column attr, type oid, type length
    out.push(view.getInt32(at));
    at += 4 + 2; // type modifier, format
  }
  return out;
};

test("#538 Describe reports the type modifier of table columns and casts", async () => {
  const server = await serve({ database: new Database() });
  const raw = await RawClient.open(server.port);
  try {
    await raw.simple(
      "CREATE TABLE tm (v varchar(32), n numeric(10,2), c char(3), ts timestamp(3), tz timestamptz(0), t time(2), iv interval(3), plain text, bare numeric, i int)",
    );
    const describe = async (sql: string): Promise<number[]> => {
      raw.parse("s1", sql);
      raw.describe("S", "s1");
      const messages = await raw.sync();
      raw.closeStatement("s1");
      await raw.sync();
      return typmods(messages.find((m) => m.type === "T")!.body);
    };
    expect(await describe("SELECT v, n, c, ts, tz, t, iv, plain, bare, i FROM tm")).toEqual([
      36, 655366, 7, 3, 0, 2, 2147418115, -1, -1, -1,
    ]);
    expect(await describe("SELECT * FROM tm")).toEqual([36, 655366, 7, 3, 0, 2, 2147418115, -1, -1, -1]);
    expect(
      await describe(
        "SELECT 'x'::varchar(8) AS lit, 1::numeric(5) AS n, 'x'::char(2) AS c, now()::timestamp(1) AS ts, 1 AS plain",
      ),
    ).toEqual([12, 327684, 6, 1, -1]);
    expect(await describe("SELECT s.v, s.n FROM (SELECT v, n FROM tm) s")).toEqual([36, 655366]);
    expect(await describe("SELECT x.v AS renamed FROM tm x")).toEqual([36]);
    expect(await describe("SELECT v || 'a', coalesce(v, 'x'), v::text, n + 1, lower(v) FROM tm")).toEqual([
      -1, -1, -1, -1, -1,
    ]);
    expect(await describe("SELECT v FROM tm UNION ALL SELECT 'a'::varchar(5)")).toEqual([-1]);
    expect(await describe("WITH c AS (SELECT n FROM tm) SELECT n FROM c")).toEqual([655366]);
    expect(await describe("SELECT 1::numeric(4,2)::numeric(5,3)")).toEqual([327687]);
    expect(await describe("SELECT '1 day'::interval(2)")).toEqual([2147418114]);
  } finally {
    raw.close();
    await server.close();
  }
});

test("#538 inet, cidr and macaddr travel as text with their type oids", async () => {
  const server = await serve({ database: new Database() });
  const client = new pg.Client({ connectionString: server.connectionString });
  await client.connect();
  try {
    const result = await client.query(
      "SELECT '10.0.0.1/8'::inet AS i, '10.0.0.0/8'::cidr AS c, '08002b010203'::macaddr AS m",
    );
    expect(result.fields.map((f) => f.dataTypeID)).toEqual([869, 650, 829]);
    expect(result.rows[0]).toEqual({ i: "10.0.0.1/8", c: "10.0.0.0/8", m: "08:00:2b:01:02:03" });
    const bound = await client.query("SELECT $1::inet AS i, $2::macaddr AS m", ["::FFFF:1.2.3.4", "08-00-2b-01-02-03"]);
    expect(bound.rows[0]).toEqual({ i: "::ffff:1.2.3.4", m: "08:00:2b:01:02:03" });
  } finally {
    await client.end();
    await server.close();
  }
});
