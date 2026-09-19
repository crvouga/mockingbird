import { expect } from "bun:test";
import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { setupBoth } from "../helpers.ts";

matrixBoth("re-executed SELECT * sees columns added by ALTER TABLE", async (memory, postgres) => {
  await setupBoth(memory, postgres, [
    "CREATE TABLE t (id serial PRIMARY KEY, name text)",
    "INSERT INTO t (name) VALUES ('a')",
  ]);
  expectParity(await memory.query("SELECT * FROM t"), await postgres.query("SELECT * FROM t"));
  expect((await memory.exec("ALTER TABLE t ADD COLUMN note text DEFAULT 'x'")).ok).toBe(true);
  expect((await postgres.exec("ALTER TABLE t ADD COLUMN note text DEFAULT 'x'")).ok).toBe(true);
  expectParity(await memory.query("SELECT * FROM t"), await postgres.query("SELECT * FROM t"));
});

matrixBoth("INSERT still works after ADD COLUMN with default", async (memory, postgres) => {
  await setupBoth(memory, postgres, ["CREATE TABLE t (id serial PRIMARY KEY, name text)"]);
  const insert = "INSERT INTO t (name) VALUES ($1)";
  expectParity(await memory.exec(insert, ["a"]), await postgres.exec(insert, ["a"]));
  expect((await memory.exec("ALTER TABLE t ADD COLUMN note text DEFAULT 'x'")).ok).toBe(true);
  expect((await postgres.exec("ALTER TABLE t ADD COLUMN note text DEFAULT 'x'")).ok).toBe(true);
  expectParity(await memory.exec(insert, ["b"]), await postgres.exec(insert, ["b"]));
  expectParity(
    await memory.query("SELECT id, name, note FROM t ORDER BY id"),
    await postgres.query("SELECT id, name, note FROM t ORDER BY id"),
  );
});

matrixBoth("query after DROP TABLE matches oracle error", async (memory, postgres) => {
  await setupBoth(memory, postgres, [
    "CREATE TABLE t (id serial PRIMARY KEY, name text)",
    "INSERT INTO t (name) VALUES ('a')",
  ]);
  expectParity(await memory.query("SELECT name FROM t"), await postgres.query("SELECT name FROM t"));
  expect((await memory.exec("DROP TABLE t")).ok).toBe(true);
  expect((await postgres.exec("DROP TABLE t")).ok).toBe(true);
  expectParity(await memory.query("SELECT name FROM t"), await postgres.query("SELECT name FROM t"), {
    messageTier: "B",
    ignoreErrorPhase: true,
  });
});

matrixBoth("query after DROP and recreate matches oracle", async (memory, postgres) => {
  await setupBoth(memory, postgres, [
    "CREATE TABLE t (id serial PRIMARY KEY, name text)",
    "INSERT INTO t (name) VALUES ('a')",
    "DROP TABLE t",
    "CREATE TABLE t (id serial PRIMARY KEY, name text)",
    "INSERT INTO t (name) VALUES ('b')",
  ]);
  expectParity(
    await memory.query("SELECT id, name FROM t ORDER BY id"),
    await postgres.query("SELECT id, name FROM t ORDER BY id"),
  );
});
