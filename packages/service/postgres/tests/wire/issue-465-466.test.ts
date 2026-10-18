import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pg from "pg";
import { type PostgresServer, serve } from "../../src/wire/index.ts";

let server: PostgresServer;

const connect = async (database: string): Promise<pg.Client> => {
  const client = new pg.Client({
    connectionString: `postgres://postgres@${server.host}:${server.port}/${encodeURIComponent(database)}`,
  });
  await client.connect();
  return client;
};

beforeAll(async () => {
  server = await serve({ port: 0 });
});

afterAll(async () => {
  await server.close();
});

describe("pg_trgm expression indexes and statement-trigger transition tables over the wire", () => {
  test("GIN indexes accept gin_trgm_ops on a text expression", async () => {
    const client = await connect("postgres");
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public");
      await client.query("CREATE TABLE public.repro (name text)");
      for (const sql of [
        "CREATE INDEX repro_idx ON public.repro USING gin (lower(name) public.gin_trgm_ops)",
        "CREATE INDEX repro_unqualified ON public.repro USING gin (lower(name) gin_trgm_ops)",
        "CREATE INDEX repro_dump ON public.repro USING gin (lower((name)::text) public.gin_trgm_ops)",
        "CREATE INDEX repro_column ON public.repro USING gin (name public.gin_trgm_ops)",
      ]) {
        await client.query(sql);
      }
      const indexes = await client.query("SELECT indexname FROM pg_indexes WHERE tablename = 'repro' ORDER BY 1");
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "repro_column",
        "repro_dump",
        "repro_idx",
        "repro_unqualified",
      ]);
    } finally {
      await client.end();
    }
  });

  test("a statement trigger reads its NEW TABLE", async () => {
    const admin = await connect("postgres");
    await admin.query("CREATE DATABASE transition_tables");
    const client = await connect("transition_tables");
    try {
      await client.query("CREATE TABLE public.events (id integer)");
      await client.query("CREATE TABLE public.event_counts (total bigint)");
      await client.query(`CREATE FUNCTION public.count_inserted() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.event_counts SELECT count(*) FROM inserted;
  RETURN NULL;
END
$$`);
      await client.query(`CREATE TRIGGER count_inserted
AFTER INSERT ON public.events
REFERENCING NEW TABLE AS inserted
FOR EACH STATEMENT EXECUTE FUNCTION public.count_inserted()`);
      await client.query("INSERT INTO public.events VALUES (1), (2)");
      expect((await client.query("SELECT total FROM public.event_counts")).rows).toEqual([{ total: "2" }]);

      // another database on the same server has neither the table nor the trigger
      const other = await connect("postgres");
      try {
        expect((await other.query("SELECT count(*)::int AS n FROM pg_trigger")).rows).toEqual([{ n: 0 }]);
      } finally {
        await other.end();
      }
    } finally {
      await client.end();
      await admin.end();
    }
  });
});
