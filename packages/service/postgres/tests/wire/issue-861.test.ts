import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import pg from "pg";
import { Database } from "../../src/index.ts";
import { type PostgresServer, serve } from "../../src/wire/index.ts";

// #861: the emulator's own savepoints (each statement of an open transaction runs inside one) are
// not subtransactions: SET TRANSACTION as the first statement after BEGIN is accepted, as in PostgreSQL.

let server: PostgresServer;
const url = () => `postgres://postgres@${server.host}:${server.port}/postgres`;

beforeAll(async () => {
  server = await serve({ port: 0, database: new Database() });
});

afterAll(async () => {
  await server.close();
});

describe("#861 SET TRANSACTION right after BEGIN over the wire", () => {
  test("Bun SQL: sql.begin + SET TRANSACTION ISOLATION LEVEL SERIALIZABLE", async () => {
    const sql = new SQL({ url: url(), max: 1 });
    try {
      const rows = await sql.begin(async (tx) => {
        await tx.unsafe("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        return [...(await tx.unsafe("SHOW transaction_isolation"))];
      });
      expect(rows).toEqual([{ transaction_isolation: "serializable" }]);
    } finally {
      await sql.close();
    }
  });

  test("pg: every SET TRANSACTION mode is accepted before the first query", async () => {
    const client = new pg.Client({ connectionString: url() });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY, DEFERRABLE");
      const shown = await client.query(
        "SELECT current_setting('transaction_isolation') AS i, current_setting('transaction_read_only') AS r, current_setting('transaction_deferrable') AS d",
      );
      expect(shown.rows).toEqual([{ i: "repeatable read", r: "on", d: "on" }]);
      await client.query("COMMIT");
    } finally {
      await client.end();
    }
  });

  test("pg: a user SAVEPOINT is still a subtransaction", async () => {
    const client = new pg.Client({ connectionString: url() });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SAVEPOINT s");
      const error = await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE").then(
        () => null,
        (e: { code?: string; message?: string }) => e,
      );
      expect(error?.code).toBe("25001");
      expect(error?.message).toBe("SET TRANSACTION ISOLATION LEVEL must not be called in a subtransaction");
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  });
});
