import { expect, test } from "bun:test";
import pg from "pg";
import { serve } from "../../src/wire/index.ts";

test("simple query comments produce empty responses and preserve transaction state (#433)", async () => {
  const server = await serve({ port: 0 });
  const client = new pg.Client({ connectionString: `postgres://postgres@${server.host}:${server.port}/postgres` });
  await client.connect();
  try {
    for (const sql of ["", " \n ", "-- footer;\n", "/* outer; /* inner; */ done */", "; -- footer;\n;"]) {
      const result = await client.query(sql);
      expect(result.command).toBeNull();
      expect((await client.query("SELECT 1 AS n")).rows).toEqual([{ n: 1 }]);
    }
    expect((await client.query("CREATE TABLE footer_rows (id int); -- footer\n")).command).toBe("CREATE");
    const results = await client.query(
      "-- intro;\n INSERT INTO footer_rows VALUES (1); /* between; */ SELECT * FROM footer_rows; -- end;",
    );
    expect(Array.isArray(results)).toBe(true);
    expect((results as unknown as pg.QueryResult[]).map((r) => r.command)).toEqual(["INSERT", "SELECT"]);
    await client.query("BEGIN");
    await expect(client.query("SELECT FROM ???; -- end")).rejects.toMatchObject({ code: "42601" });
    await expect(client.query("SELECT 1")).rejects.toMatchObject({ code: "25P02" });
    await client.query("ROLLBACK");
    expect((await client.query("SELECT 1 AS n")).rows).toEqual([{ n: 1 }]);
  } finally {
    await client.end();
    await server.close();
  }
});
