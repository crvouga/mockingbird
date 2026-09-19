import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";
import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { expectStateParity } from "../../harness/state-dump.ts";
import { setupBoth } from "../helpers.ts";

// FZZ-snap-02: views, matviews, sequences, enums, triggers, multi-schema
const cases = [
  {
    name: "regular view",
    setup: [
      "CREATE TABLE t (id serial PRIMARY KEY, a int, b text)",
      "CREATE VIEW v AS SELECT id, a FROM t WHERE a > 0",
      "INSERT INTO t (a, b) VALUES (1, 'x'), (0, 'y')",
    ],
    probes: ["SELECT id, a FROM v ORDER BY id", "SELECT id, a, b FROM t ORDER BY id"],
  },
  {
    name: "materialized view",
    setup: [
      "CREATE TABLE t (id serial PRIMARY KEY, a int)",
      "INSERT INTO t (a) VALUES (1), (2)",
      "CREATE MATERIALIZED VIEW mv AS SELECT id, a FROM t",
    ],
    probes: ["SELECT id, a FROM mv ORDER BY id"],
  },
  {
    name: "sequence continuity",
    setup: ["CREATE TABLE t (id serial PRIMARY KEY, a int)", "INSERT INTO t (a) VALUES (1), (2)"],
    probes: [
      "SELECT id, a FROM t ORDER BY id",
      "SELECT last_value::text AS last_value FROM pg_sequences WHERE sequencename = 't_id_seq'",
    ],
  },
  {
    name: "enum and domain",
    setup: [
      "CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')",
      "CREATE DOMAIN posint AS int CHECK (VALUE > 0)",
      "CREATE TABLE t (id serial PRIMARY KEY, m mood, n posint)",
      "INSERT INTO t (m, n) VALUES ('ok', 3)",
    ],
    probes: ["SELECT id, m::text AS m, n FROM t ORDER BY id"],
  },
  {
    name: "SQL function",
    setup: [
      "CREATE FUNCTION add1(x int) RETURNS int LANGUAGE sql AS $$ SELECT x + 1 $$",
      "CREATE TABLE t (id serial PRIMARY KEY, a int)",
      "INSERT INTO t (a) VALUES (1)",
    ],
    probes: ["SELECT id, add1(a) AS v FROM t ORDER BY id"],
  },
  {
    name: "multi-schema",
    setup: [
      "CREATE SCHEMA other",
      "CREATE TABLE t (id serial PRIMARY KEY, a int)",
      "CREATE TABLE other.t (id int PRIMARY KEY, a int)",
      "INSERT INTO t (a) VALUES (1)",
      "INSERT INTO other.t VALUES (1, 10)",
    ],
    probes: ["SELECT id, a FROM t ORDER BY id", "SELECT id, a FROM other.t ORDER BY id"],
  },
] as const;

for (const c of cases) {
  test(`snapshot round-trip preserves ${c.name}`, () => {
    const source = new Database({ seed: 7 });
    try {
      for (const sql of c.setup) source.exec(sql);
      const before = Object.fromEntries(c.probes.map((sql) => [sql, source.query(sql)]));
      const restored = source.snapshot().open();
      for (const sql of c.probes) {
        expect(restored.query(sql)).toEqual(before[sql]);
      }
      restored.close();
    } finally {
      source.close();
    }
  });
}

test("BEFORE INSERT trigger still mutates rows after snapshot restore", () => {
  const db = new Database({ seed: 3 });
  try {
    db.exec("CREATE TABLE t (id serial PRIMARY KEY, a int)");
    db.exec(
      "CREATE FUNCTION bump_a() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.a := NEW.a + 1; RETURN NEW; END $$",
    );
    db.exec("CREATE TRIGGER t_bi BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION bump_a()");
    const restored = db.snapshot().open();
    restored.exec("INSERT INTO t (a) VALUES (10)");
    expect(restored.query("SELECT a FROM t ORDER BY id")).toEqual([{ a: 11 }]);
    restored.close();
  } finally {
    db.close();
  }
});

matrixBoth("post-restore queries stay in lockstep with oracle (views + matview)", async (memory, postgres) => {
  await setupBoth(memory, postgres, [
    "CREATE TABLE t (id serial PRIMARY KEY, a int, b text)",
    "CREATE INDEX t_a ON t (a)",
    "CREATE VIEW v AS SELECT id, a FROM t WHERE a > 0",
    "INSERT INTO t (a, b) VALUES (1, 'x'), (0, 'y')",
    "CREATE MATERIALIZED VIEW mv AS SELECT id, a FROM t WHERE a > 0",
  ]);
  const snap = memory.snapshot();
  await memory.exec("DELETE FROM t");
  memory.restore(snap);
  await expectStateParity(memory, postgres);
  const probes = [
    "SELECT id, a FROM v ORDER BY id",
    "SELECT id, a FROM mv ORDER BY id",
    "SELECT last_value::text AS last_value FROM pg_sequences WHERE sequencename = 't_id_seq'",
  ];
  for (const sql of probes) {
    expectParity(await memory.query(sql), await postgres.query(sql), { ignoreWriteCounters: true });
  }
});

test("restore into a fresh adapter preserves matview rows", async () => {
  const source = new InMemoryAdapter();
  const target = new InMemoryAdapter();
  try {
    await source.exec("CREATE TABLE t (id serial PRIMARY KEY, a int)");
    await source.exec("INSERT INTO t (a) VALUES (1), (2)");
    await source.exec("CREATE MATERIALIZED VIEW mv AS SELECT id, a FROM t");
    target.restore(source.snapshot());
    const rows = await target.query("SELECT id, a FROM mv ORDER BY id");
    expect(rows.ok).toBe(true);
    expect(rows.rows.length).toBe(2);
  } finally {
    await source.close();
    await target.close();
  }
});
