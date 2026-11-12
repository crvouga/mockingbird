import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { errorParity, sequenceParity } from "../helpers.ts";

const sqlStateOf = (sql: string, setup: string[] = []): string | undefined => {
  const db = new Database();
  for (const statement of setup) db.exec(statement);
  try {
    db.exec(sql);
  } catch (error) {
    return (error as { sqlState?: string }).sqlState;
  }
  return undefined;
};

const IDEMPOTENT_TYPE = `DO $$ BEGIN
  CREATE TYPE dbk.retry_status AS ENUM ('pending', 'resolved');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$`;

// #534 DO blocks run
sequenceParity(
  "#534 idempotent CREATE TYPE creates the type once",
  ["CREATE SCHEMA dbk", "CREATE TABLE dbk.t (id int PRIMARY KEY)"],
  [
    { sql: IDEMPOTENT_TYPE },
    { sql: IDEMPOTENT_TYPE },
    {
      sql: "SELECT count(*)::int AS types_created FROM pg_type WHERE typname = 'retry_status' AND typnamespace = 'dbk'::regnamespace",
      query: true,
    },
    { sql: "CREATE TABLE dbk.u (id int, s dbk.retry_status NOT NULL DEFAULT 'pending')" },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "#534 conditional DDL guarded by IF NOT EXISTS",
  ["CREATE SCHEMA dbk", "CREATE TABLE dbk.t (id int PRIMARY KEY)"],
  [
    {
      sql: `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'dbk' AND table_name = 't' AND column_name = 'extra') THEN
          ALTER TABLE dbk.t ADD COLUMN extra int;
        END IF;
      END $$`,
    },
    {
      sql: `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'dbk' AND table_name = 't' AND column_name = 'extra') THEN
          ALTER TABLE dbk.t ADD COLUMN extra int;
        END IF;
      END $$`,
    },
    {
      sql: "SELECT count(*)::int AS column_added FROM information_schema.columns WHERE table_schema = 'dbk' AND table_name = 't' AND column_name = 'extra'",
      query: true,
    },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "#534 LANGUAGE clause and dynamic SQL through EXECUTE format()",
  ["CREATE SCHEMA dbk"],
  [
    { sql: "DO LANGUAGE plpgsql $$ BEGIN EXECUTE format('CREATE TABLE dbk.%I (id int)', 'made_by_do'); END $$" },
    { sql: "DO $$ BEGIN EXECUTE 'CREATE TABLE dbk.b (id int)'; EXECUTE 'INSERT INTO dbk.b VALUES (1), (2)'; END $$" },
    {
      sql: "SELECT relname FROM pg_class WHERE relnamespace = 'dbk'::regnamespace AND relkind = 'r' ORDER BY 1",
      query: true,
    },
    { sql: "SELECT id FROM dbk.b ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "#534 DECLARE, assignment and loops over DML",
  ["CREATE TABLE n (v int)"],
  [
    {
      sql: `DO $$ DECLARE total int := 2; BEGIN
        total := total * 3;
        INSERT INTO n VALUES (total);
        IF total > 5 THEN INSERT INTO n VALUES (total + 1); ELSE INSERT INTO n VALUES (0); END IF;
      END $$`,
    },
    { sql: "SELECT v FROM n ORDER BY v", query: true },
  ],
);

errorParity("#534 RAISE EXCEPTION fails with P0001 and its message", [], "DO $$ BEGIN RAISE EXCEPTION 'boom'; END $$");
errorParity(
  "#534 RAISE substitutes % placeholders",
  [],
  "DO $$ DECLARE n int := 2; BEGIN IF n > 1 THEN RAISE EXCEPTION 'n=%, s=%, 100%%', n, 'x'; END IF; END $$",
);
errorParity(
  "#534 RAISE ... USING ERRCODE names the condition",
  [],
  "DO $$ BEGIN RAISE EXCEPTION 'dup' USING ERRCODE = 'unique_violation'; END $$",
  "constraint_unique",
);
errorParity("#534 RAISE with too few arguments", [], "DO $$ BEGIN RAISE EXCEPTION 'a % %', 1; END $$");
errorParity("#534 RAISE with too many arguments", [], "DO $$ BEGIN RAISE EXCEPTION 'a', 1; END $$");
errorParity("#534 unknown exception condition", [], "DO $$ BEGIN NULL; EXCEPTION WHEN nope THEN NULL; END $$");
errorParity("#534 a language without inline code", [], "DO LANGUAGE sql $$ SELECT 1 $$");
errorParity("#534 an unknown language", [], "DO LANGUAGE nope $$ SELECT 1 $$");
errorParity(
  "#534 a handler for another condition does not catch",
  [],
  "DO $$ BEGIN PERFORM 1 / 0; EXCEPTION WHEN unique_violation THEN NULL; END $$",
);

sequenceParity(
  "#534 the handler catches by name, class, SQLSTATE and OTHERS",
  ["CREATE TABLE h (id int PRIMARY KEY)", "INSERT INTO h VALUES (1)"],
  [
    {
      sql: "DO $$ BEGIN INSERT INTO h VALUES (1); EXCEPTION WHEN unique_violation THEN INSERT INTO h VALUES (2); END $$",
    },
    {
      sql: "DO $$ BEGIN INSERT INTO h VALUES (1); EXCEPTION WHEN integrity_constraint_violation THEN INSERT INTO h VALUES (3); END $$",
    },
    {
      sql: "DO $$ BEGIN INSERT INTO h VALUES (1); EXCEPTION WHEN SQLSTATE '23505' THEN INSERT INTO h VALUES (4); END $$",
    },
    {
      sql: "DO $$ BEGIN INSERT INTO h VALUES (1); EXCEPTION WHEN not_null_violation OR unique_violation THEN INSERT INTO h VALUES (5); END $$",
    },
    { sql: "DO $$ BEGIN PERFORM 1 / 0; EXCEPTION WHEN division_by_zero THEN INSERT INTO h VALUES (6); END $$" },
    {
      sql: "DO $$ BEGIN PERFORM 1 / 0; EXCEPTION WHEN unique_violation THEN INSERT INTO h VALUES (90); WHEN OTHERS THEN INSERT INTO h VALUES (7); END $$",
    },
    { sql: "SELECT id FROM h ORDER BY id", query: true },
  ],
);

sequenceParity(
  "#534 a caught error takes back what the block wrote",
  ["CREATE TABLE s1 (id int PRIMARY KEY)"],
  [
    {
      sql: `DO $$ BEGIN
        CREATE TABLE s2 (id int);
        INSERT INTO s1 VALUES (1);
        INSERT INTO s1 VALUES (1);
      EXCEPTION WHEN unique_violation THEN INSERT INTO s1 VALUES (10);
      END $$`,
    },
    { sql: "SELECT id FROM s1 ORDER BY id", query: true },
    { sql: "SELECT count(*)::int AS n FROM pg_class WHERE relname = 's2'", query: true },
    {
      sql: `DO $$ BEGIN
        INSERT INTO s1 VALUES (20);
        BEGIN
          INSERT INTO s1 VALUES (21);
          PERFORM 1 / 0;
        EXCEPTION WHEN division_by_zero THEN INSERT INTO s1 VALUES (22);
        END;
        INSERT INTO s1 VALUES (23);
      END $$`,
    },
    { sql: "SELECT id FROM s1 ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "#534 an uncaught error leaves none of the block's writes",
  ["CREATE TABLE a1 (id int PRIMARY KEY)"],
  [
    { sql: "DO $$ BEGIN INSERT INTO a1 VALUES (1); CREATE TABLE a2 (id int); INSERT INTO a1 VALUES (1); END $$" },
    { sql: "SELECT count(*)::int AS n FROM a1", query: true },
    { sql: "SELECT count(*)::int AS n FROM pg_class WHERE relname = 'a2'", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "#534 SQLERRM, SQLSTATE and a bare RAISE inside a handler",
  [],
  [
    { sql: "CREATE TABLE e (state text, msg text)" },
    {
      sql: "DO $$ BEGIN CREATE TABLE e (id int); EXCEPTION WHEN duplicate_table THEN INSERT INTO e VALUES (sqlstate, sqlerrm); END $$",
    },
    { sql: "SELECT state, msg FROM e", query: true },
    { sql: "DO $$ BEGIN CREATE TABLE e (id int); EXCEPTION WHEN OTHERS THEN RAISE; END $$" },
    {
      sql: "DO $$ BEGIN CREATE TABLE e (id int); EXCEPTION WHEN duplicate_table THEN RAISE EXCEPTION 'wrapped: %', sqlerrm; END $$",
    },
  ],
);

sequenceParity(
  "#534 RAISE below EXCEPTION is not an error",
  [],
  [{ sql: "DO $$ BEGIN RAISE NOTICE 'hi %', 1; RAISE WARNING 'careful'; RAISE LOG 'x'; RAISE INFO 'y'; END $$" }],
);

sequenceParity(
  "#534 DO inside a transaction rolls back with it",
  ["CREATE TABLE r (id int)"],
  [
    { sql: "BEGIN" },
    { sql: "DO $$ BEGIN INSERT INTO r VALUES (1); CREATE TABLE r2 (id int); END $$" },
    { sql: "SELECT count(*)::int AS n FROM r", query: true },
    { sql: "ROLLBACK" },
    { sql: "SELECT count(*)::int AS n FROM r", query: true },
    { sql: "SELECT count(*)::int AS n FROM pg_class WHERE relname = 'r2'", query: true },
  ],
);

// #682: these constructs run now (see tests/contract/functions/plpgsql-statements.test.ts)
sequenceParity(
  "#682 SELECT INTO, integer FOR, EXECUTE ... INTO / USING and GET DIAGNOSTICS in a DO block",
  ["CREATE TABLE out (v text)"],
  [
    {
      sql: `DO $$ DECLARE c int; d int; t int := 0; BEGIN
        SELECT count(*) INTO c FROM out;
        FOR i IN 1..3 LOOP t := t + i; END LOOP;
        EXECUTE 'SELECT $1 * 2' INTO d USING t;
        INSERT INTO out VALUES (c::text), (t::text), (d::text);
        GET DIAGNOSTICS c = ROW_COUNT;
        INSERT INTO out VALUES ('rows ' || c);
      END $$`,
    },
    { sql: "SELECT v FROM out ORDER BY v", query: true },
  ],
);

// #682: cursors and transaction control run in DO blocks now (tests/contract/functions/plpgsql-cursors.test.ts,
// tests/contract/functions/procedures.test.ts); what is still not modelled keeps failing loud.
sequenceParity(
  "#534 cursors and COMMIT in a DO block",
  ["CREATE TABLE out (v text)"],
  [
    { sql: "DO $$ DECLARE c CURSOR FOR SELECT 1; BEGIN NULL; END $$" },
    {
      sql: "DO $$ DECLARE c refcursor; r record; BEGIN OPEN c FOR SELECT 1 AS one; FETCH c INTO r; INSERT INTO out VALUES (r.one::text); END $$",
    },
    { sql: "DO $$ DECLARE c refcursor; r record; BEGIN FETCH c INTO r; END $$" },
    { sql: "DO $$ BEGIN INSERT INTO out VALUES ('committed'); COMMIT; END $$" },
    { sql: "SELECT v FROM out ORDER BY v", query: true },
  ],
);

test("#534 an unsupported construct fails loud with 0A000 (GET DIAGNOSTICS PG_ROUTINE_OID)", () => {
  expect(sqlStateOf("DO $$ DECLARE o oid; BEGIN GET DIAGNOSTICS o = PG_ROUTINE_OID; END $$")).toBe("0A000");
});

test("#534 a failed unsupported DO leaves earlier statements' effects alone", () => {
  const db = new Database();
  db.exec("CREATE TABLE keep (id int)");
  expect(() =>
    db.exec("DO $$ DECLARE o oid; BEGIN INSERT INTO keep VALUES (1); GET DIAGNOSTICS o = PG_ROUTINE_OID; END $$"),
  ).toThrow();
  expect(db.query("SELECT count(*)::int AS n FROM keep")[0]).toEqual({ n: 0 });
});
