import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type PostgresServer, serve } from "../../src/wire/index.ts";
import {
  type BackendMessage,
  dataRow,
  errorFields,
  fromHex,
  hex,
  parameterOids,
  RawClient,
  rowDescription,
} from "./raw-client.ts";

/**
 * Extended-protocol Describe, binary results and binary parameters. Expected OIDs and bytes
 * were read from a real PostgreSQL 18.0 (embedded, trust auth, `timezone=UTC`) with the same
 * raw messages; the issue reports (#524-#527) carry the same captures from asyncpg and psycopg.
 */

let server: PostgresServer;
let client: RawClient;

beforeAll(async () => {
  server = await serve({ port: 0 });
  client = await RawClient.open(server.port, { user: "postgres" });
  await client.simple("SET TIME ZONE 'UTC'");
  await client.simple("CREATE TABLE dp (id int PRIMARY KEY, name text)");
  await client.simple(
    "CREATE TABLE bp (j jsonb, n numeric, t timestamptz, ts timestamp, iv interval, tm time, a int4[])",
  );
});

afterAll(async () => {
  client.close();
  await server.close();
});

const of = (messages: BackendMessage[], type: string): BackendMessage | undefined =>
  messages.find((m) => m.type === type);

/** `Parse` with no parameter types, then `Describe` statement: what asyncpg and `\gdesc` send. */
const describeStatement = async (sql: string, oids: number[] = []) => {
  client.parse("", sql, oids);
  client.describe("S", "");
  const messages = await client.sync();
  const failure = of(messages, "E");
  if (failure) throw new Error(JSON.stringify(errorFields(failure)));
  const description = of(messages, "T");
  return {
    params: parameterOids(of(messages, "t") as BackendMessage),
    columns: description ? rowDescription(description).map((column) => column.oid) : "NoData",
  };
};

/** `Parse`, `Bind` (explicit formats), `Execute`: the first DataRow cell, or the error. */
const run = async (
  sql: string,
  options: {
    oids?: number[];
    paramFormats?: number[];
    params?: (string | Uint8Array | null)[];
    resultFormats?: number[];
  } = {},
): Promise<{ cell: Uint8Array | null; error?: Record<string, string> }> => {
  client.parse("", sql, options.oids ?? []);
  client.bind({ paramFormats: options.paramFormats, params: options.params, resultFormats: options.resultFormats });
  client.execute();
  const messages = await client.sync();
  const failure = of(messages, "E");
  if (failure) return { cell: null, error: errorFields(failure) };
  const row = of(messages, "D");
  return { cell: row ? (dataRow(row)[0] ?? null) : null };
};

const text = (cell: Uint8Array | null): string => new TextDecoder().decode(cell as Uint8Array);

describe("#524 Describe infers parameter types and the row shape", () => {
  test.each([
    ["SELECT $1::text", [25], [25]],
    ["SELECT $1::int, $2::varchar", [23, 1043], [23, 1043]],
    ["SELECT name FROM dp WHERE id = $1", [23], [25]],
    ["SELECT name FROM dp LIMIT $1", [20], [25]],
    ["SELECT name FROM dp LIMIT 1 OFFSET $1", [20], [25]],
    ["SELECT $1", [25], [25]],
    ["SELECT 1", [], [23]],
  ] as const)("%s", async (sql, params, columns) => {
    expect(await describeStatement(sql)).toEqual({ params: [...params], columns: [...columns] });
  });

  test("INSERT takes the column types and answers NoData", async () => {
    expect(await describeStatement("INSERT INTO dp (id, name) VALUES ($1, $2)")).toEqual({
      params: [23, 25],
      columns: "NoData",
    });
  });

  test("a type the client declared in Parse is kept", async () => {
    expect((await describeStatement("SELECT $1::text, $2::int", [20, 0])).params).toEqual([20, 23]);
  });

  test("an untyped Parse then Bind with text parameters runs", async () => {
    const result = await run("SELECT $1::text || 'x'", { params: ["a"] });
    expect(text(result.cell)).toBe("ax");
  });
});

describe("#525 Describe sees a table created in the open transaction", () => {
  test("SELECT and INSERT ... RETURNING describe their columns", async () => {
    await client.simple("BEGIN");
    await client.simple("CREATE TABLE tx_t (id int PRIMARY KEY, v text NOT NULL)");
    expect(await describeStatement("SELECT v FROM tx_t")).toEqual({ params: [], columns: [25] });
    expect(await describeStatement("SELECT v FROM tx_t WHERE id = $1")).toEqual({ params: [23], columns: [25] });
    expect(await describeStatement("INSERT INTO tx_t (id, v) VALUES (2, 'b') RETURNING v")).toEqual({
      params: [],
      columns: [25],
    });
    expect(await describeStatement("INSERT INTO tx_t (id, v) VALUES ($1, $2)")).toEqual({
      params: [23, 25],
      columns: "NoData",
    });
    await client.simple("ROLLBACK");
    const gone = await client.simple("SELECT 1 FROM tx_t");
    expect(errorFields(of(gone, "E") as BackendMessage).C).toBe("42P01");
  });
});

describe("#526 binary result formats", () => {
  test.each([
    ["SELECT 1.25::numeric", "0002000000000002000109c4"],
    ["SELECT 0::numeric", "0000000000000000"],
    ["SELECT -12345.6789::numeric", "0003000140000004000109291a85"],
    ["SELECT 'NaN'::numeric", "00000000c0000000"],
    ["SELECT 100000::numeric", "0001000100000000000a"],
    ["SELECT 0.00012::numeric", "0002ffff00000005000107d0"],
    ["SELECT '2026-01-02'::date", "0000251a"],
    ["SELECT '1999-12-31'::date", "ffffffff"],
    ["SELECT '12:34:56'::time", "0000000a8bda1c00"],
    ["SELECT '01:00:00.5'::time", "00000000d69b4520"],
    ["SELECT '2026-01-02 03:04:05.123456'::timestamp", "0002ea5dbb16f580"],
    ["SELECT '-1 day -1 hour'::interval", "ffffffff296c5c00ffffffff00000000"],
    ["SELECT '2026-01-02 03:04:05'::timestamp", "0002ea5dbb151340"],
    ["SELECT '2026-01-02 03:04:05+00'::timestamptz", "0002ea5dbb151340"],
    ["SELECT '1 day 2 hours'::interval", "00000001ad2748000000000100000000"],
    [`SELECT '{"a": 1}'::jsonb`, "017b2261223a20317d"],
    ["SELECT '{1,2}'::int4[]", "000000010000000000000017000000020000000100000004000000010000000400000002"],
    [
      "SELECT '{{1,2},{3,NULL}}'::int4[]",
      "00000002000000010000001700000002000000010000000200000001000000040000000100000004000000020000000400000003ffffffff",
    ],
    ["SELECT ARRAY[]::int4[]", "000000000000000000000017"],
    ["SELECT '{a,b}'::text[]", "000000010000000000000019000000020000000100000001610000000162"],
  ])("%s", async (sql, expected) => {
    const result = await run(sql, { resultFormats: [1] });
    expect(result.error).toBeUndefined();
    expect(hex(result.cell as Uint8Array)).toBe(expected);
  });

  test("a type with no binary layout is refused loudly, not sent as text", async () => {
    const result = await run("SELECT 'a'::tsvector", { resultFormats: [1] });
    expect(result.error?.C).toBe("0A000");
  });

  test("the same type is sent as text when the client described the portal", async () => {
    client.parse("", "SELECT 'a b'::tsvector");
    client.bind({ resultFormats: [1] });
    client.describe("P", "");
    client.execute();
    const messages = await client.sync();
    expect(of(messages, "E")).toBeUndefined();
    const [column] = rowDescription(of(messages, "T") as BackendMessage);
    expect(column?.format).toBe(0);
    expect(text(dataRow(of(messages, "D") as BackendMessage)[0] ?? null)).toBe("'a' 'b'");
  });
});

describe("#527 binary parameters", () => {
  const param = async (oid: number, bytes: string, cast: string): Promise<string> => {
    const result = await run(`SELECT $1::${cast}::text`, { oids: [oid], paramFormats: [1], params: [fromHex(bytes)] });
    expect(result.error).toBeUndefined();
    return text(result.cell);
  };

  test("numeric", async () => {
    expect(await param(1700, "0002000000000002000109c4", "numeric")).toBe("1.25");
    expect(await param(1700, "0003000140000004000109291a85", "numeric")).toBe("-12345.6789");
    expect(await param(1700, "0000000000000000", "numeric")).toBe("0");
    expect(await param(1700, "00000000c0000000", "numeric")).toBe("NaN");
  });

  test("jsonb drops the version byte", async () => {
    expect(await param(3802, "017b2261223a20317d", "jsonb")).toBe('{"a": 1}');
    const stored = await run("INSERT INTO bp (j) VALUES ($1) RETURNING j::text", {
      oids: [3802],
      paramFormats: [1],
      params: [fromHex("017b2261223a20317d")],
    });
    expect(text(stored.cell)).toBe('{"a": 1}');
  });

  test("timestamp and timestamptz keep microseconds", async () => {
    // 2026-01-02 03:04:05.123456 as microseconds since 2000-01-01
    const micros = (BigInt(Date.UTC(2026, 0, 2, 3, 4, 5)) - BigInt(Date.UTC(2000, 0, 1))) * 1000n + 123456n;
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, micros);
    for (const [oid, cast] of [
      [1114, "timestamp"],
      [1184, "timestamptz"],
    ] as const) {
      const result = await run(`SELECT to_char($1::${cast}, 'YYYY-MM-DD HH24:MI:SS.US')`, {
        oids: [oid],
        paramFormats: [1],
        params: [bytes],
      });
      expect(text(result.cell)).toBe("2026-01-02 03:04:05.123456");
    }
  });

  test("interval, time and arrays", async () => {
    expect(await param(1186, "00000000d693a4000000000100000000", "interval")).toBe("1 day 01:00:00");
    expect(await param(1083, "00000000da366d40", "time")).toBe("01:01:01");
    expect(
      await param(1007, "000000010000000000000017000000020000000100000004000000070000000400000009", "int4[]"),
    ).toBe("{7,9}");
  });

  test("an unsupported type is still 0A000", async () => {
    const result = await run("SELECT $1::text", { oids: [600], paramFormats: [1], params: [fromHex("00")] });
    expect(result.error?.C).toBe("0A000");
  });

  test("the type Describe inferred decodes a binary parameter left undeclared", async () => {
    const bytes = fromHex("0002000000000002000109c4");
    client.parse("s_num", "INSERT INTO bp (n) VALUES ($1) RETURNING n::text");
    client.describe("S", "s_num");
    client.bind({ statement: "s_num", paramFormats: [1], params: [bytes] });
    client.execute();
    const messages = await client.sync();
    expect(parameterOids(of(messages, "t") as BackendMessage)).toEqual([1700]);
    expect(text(dataRow(of(messages, "D") as BackendMessage)[0] ?? null)).toBe("1.25");
  });
});
