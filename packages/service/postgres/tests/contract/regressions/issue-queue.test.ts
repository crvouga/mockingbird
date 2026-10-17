import { expect, test } from "bun:test";
import { Database, Snapshot } from "../../../src/index.ts";
import { parity, sequenceParity, queryErrorParity } from "../helpers.ts";

for (const language of ["sql", "plpgsql"]) {
  const body =
    language === "sql" ? "SELECT current_setting('search_path')" : "BEGIN RETURN current_setting('search_path'); END";
  sequenceParity(
    `#442 ${language} function-local comma-separated search_path`,
    [
      "SET search_path TO public",
      `CREATE FUNCTION local_path() RETURNS text LANGUAGE ${language} SET search_path TO 'pg_catalog', 'pg_temp' AS '${body.replaceAll("'", "''")}'`,
    ],
    [
      { sql: "SELECT local_path()", query: true },
      { sql: "SHOW search_path", query: true },
    ],
  );
}

sequenceParity(
  "#445 regclass sequence arguments",
  ['CREATE SCHEMA "Mixed"', 'CREATE SEQUENCE "Mixed"."Seq"'],
  [
    { sql: `SELECT nextval('"Mixed"."Seq"'::regclass)`, query: true },
    { sql: `SELECT currval('"Mixed"."Seq"'::regclass)`, query: true },
    { sql: `SELECT setval('"Mixed"."Seq"'::regclass, 12, true)`, query: true },
    { sql: `SELECT nextval('"Mixed"."Seq"'::regclass)`, query: true },
  ],
);
queryErrorParity("#445 absent regclass relation", [], "SELECT 'missing_sequence'::regclass");
queryErrorParity("#445 malformed regclass input", [], `SELECT '"unterminated'::regclass`);

parity(
  "#446 exact mixed-case column #447 serial ownership",
  [
    'CREATE SCHEMA "Mixed"',
    'CREATE TABLE "Mixed"."Tbl" ("camelId" serial, ident bigint GENERATED ALWAYS AS IDENTITY, plain int)',
  ],
  `SELECT pg_get_serial_sequence('"Mixed"."Tbl"', 'camelId'), pg_get_serial_sequence('"Mixed"."Tbl"', 'ident'), pg_get_serial_sequence('"Mixed"."Tbl"', 'plain')`,
);
queryErrorParity(
  "#446 no lowercase fallback",
  ['CREATE TABLE case_column ("camelId" serial)'],
  "SELECT pg_get_serial_sequence('case_column', 'camelid')",
);
sequenceParity(
  "#447 explicit ownership survives table and column rename",
  ["CREATE TABLE owned (id int)", "CREATE SEQUENCE custom_seq", "ALTER SEQUENCE custom_seq OWNED BY owned.id"],
  [
    { sql: "SELECT pg_get_serial_sequence('owned', 'id')", query: true },
    { sql: "ALTER TABLE owned RENAME COLUMN id TO value" },
    { sql: "ALTER TABLE owned RENAME TO renamed" },
    { sql: "ALTER SEQUENCE custom_seq RENAME TO renamed_seq" },
    { sql: "SELECT pg_get_serial_sequence('renamed', 'value')", query: true },
  ],
);

test("#442 #445 #446 #447 snapshots retain settings, defaults and ownership", () => {
  const db = new Database();
  db.exec(
    `CREATE TABLE snap ("camelId" serial, ident bigint GENERATED ALWAYS AS IDENTITY); CREATE FUNCTION snap_path() RETURNS text LANGUAGE sql SET search_path TO 'pg_catalog', 'pg_temp' AS 'SELECT current_setting(''search_path'')'`,
  );
  const restored = Snapshot.decode(db.snapshot().encode()).open();
  expect(restored.query("SELECT snap_path() AS path")).toEqual([{ path: "pg_catalog, pg_temp" }]);
  expect(restored.query(`SELECT pg_get_serial_sequence('snap', 'camelId') AS seq`)).toEqual([
    { seq: 'public."snap_camelId_seq"' },
  ]);
  restored.exec(
    `CREATE SEQUENCE explicit_seq; CREATE TABLE explicit_default (id bigint DEFAULT nextval('explicit_seq'::regclass)); INSERT INTO explicit_default DEFAULT VALUES`,
  );
  const restoredAgain = Snapshot.decode(restored.snapshot().encode()).open();
  restoredAgain.exec("INSERT INTO explicit_default DEFAULT VALUES");
  expect(restoredAgain.query("SELECT id FROM explicit_default ORDER BY id")).toEqual([{ id: 1n }, { id: 2n }]);
});

parity(
  "#462 xmin is a hidden xid system column",
  ["CREATE TABLE versioned (id int)", "INSERT INTO versioned VALUES (1)"],
  "SELECT pg_typeof(xmin)::text AS type, row_to_json(v)::text AS row FROM versioned v",
);

test("#462 row xmin changes on writes, groups transactions, rolls back and survives snapshots", () => {
  const db = new Database();
  db.exec("CREATE TABLE versions (id int PRIMARY KEY); INSERT INTO versions VALUES (1)");
  const xmin = () => db.query<{ xmin: string }>("SELECT v.xmin::text AS xmin FROM versions v WHERE id = 1")[0]!.xmin;
  const first = xmin();
  expect(xmin()).toBe(first);
  db.exec("BEGIN; UPDATE versions SET id = id WHERE id = 1");
  expect(xmin()).not.toBe(first);
  db.exec("ROLLBACK");
  expect(xmin()).toBe(first);
  db.exec("BEGIN; UPDATE versions SET id = id; INSERT INTO versions VALUES (2); COMMIT");
  const changed = xmin();
  expect(changed).not.toBe(first);
  expect(db.query("SELECT DISTINCT xmin::text AS xmin FROM versions")).toEqual([{ xmin: changed }]);
  expect(db.query("SELECT v.* FROM versions v ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }]);
  const restored = Snapshot.decode(db.snapshot().encode()).open();
  expect(restored.query("SELECT xmin::text AS xmin FROM versions ORDER BY id")).toEqual([
    { xmin: changed },
    { xmin: changed },
  ]);
  restored.exec("UPDATE versions SET id = id WHERE id = 1");
  expect(restored.query("SELECT xmin::text AS xmin FROM versions WHERE id = 1")[0]!.xmin).not.toBe(changed);
  expect(xmin()).toBe(changed);
});

sequenceParity(
  "#462 differential row version transaction semantics",
  ["CREATE TABLE version_oracle (id int PRIMARY KEY)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO version_oracle VALUES (1)" },
    { sql: "INSERT INTO version_oracle VALUES (2)" },
    { sql: "SELECT count(DISTINCT xmin::text) = 1 AS same_transaction FROM version_oracle", query: true },
    { sql: "COMMIT" },
    { sql: "CREATE TABLE old_versions AS SELECT id, xmin::text AS version FROM version_oracle" },
    { sql: "BEGIN" },
    { sql: "UPDATE version_oracle SET id = id WHERE id = 1" },
    {
      sql: "SELECT v.xmin::text <> o.version AS changed FROM version_oracle v JOIN old_versions o USING (id) WHERE v.id = 1",
      query: true,
    },
    { sql: "ROLLBACK" },
    {
      sql: "SELECT v.xmin::text = o.version AS restored FROM version_oracle v JOIN old_versions o USING (id) ORDER BY id",
      query: true,
    },
  ],
);

sequenceParity(
  "#447 fixture sequence resets and renamed serial defaults",
  ["CREATE TABLE fixture (id serial PRIMARY KEY)"],
  [
    { sql: "INSERT INTO fixture VALUES (10)" },
    { sql: "SELECT setval(pg_get_serial_sequence('fixture', 'id'), 10, true)", query: true },
    { sql: "ALTER SEQUENCE fixture_id_seq RENAME TO fixture_renamed_seq" },
    { sql: "INSERT INTO fixture DEFAULT VALUES" },
    { sql: "SELECT id FROM fixture ORDER BY id", query: true },
  ],
);
sequenceParity(
  "#446 mixed-case serial generated values",
  ['CREATE SCHEMA "Quoted"', 'CREATE TABLE "Quoted"."Tbl" ("camelId" serial PRIMARY KEY)'],
  [{ sql: 'INSERT INTO "Quoted"."Tbl" DEFAULT VALUES' }, { sql: 'SELECT "camelId" FROM "Quoted"."Tbl"', query: true }],
);

for (const language of ["sql", "plpgsql"]) {
  const body = language === "sql" ? "SELECT value FROM chosen" : "BEGIN RETURN (SELECT value FROM chosen); END";
  sequenceParity(
    `#442 ${language} search_path resolves objects and restores caller`,
    [
      "SET search_path TO public",
      "CREATE SCHEMA function_scope",
      "CREATE TABLE public.chosen(value int)",
      "CREATE TABLE function_scope.chosen(value int)",
      "INSERT INTO public.chosen VALUES(1)",
      "INSERT INTO function_scope.chosen VALUES(2)",
      `CREATE FUNCTION scoped_read() RETURNS int LANGUAGE ${language} SET search_path TO 'function_scope', 'public' AS '${body}'`,
    ],
    [
      { sql: "SELECT scoped_read() AS value", query: true },
      { sql: "SELECT value FROM chosen", query: true },
    ],
  );
}

test("#442 function-local settings restore on error", () => {
  const db = new Database();
  db.exec(
    "SET search_path TO public; CREATE FUNCTION failure() RETURNS int LANGUAGE sql SET search_path TO 'pg_catalog', 'pg_temp' AS 'SELECT 1 / 0'",
  );
  expect(() => db.query("SELECT failure()")).toThrow();
  expect(db.query("SHOW search_path")).toEqual([{ search_path: "public" }]);
});

parity(
  "#445 regclass values compare by relation identity",
  ["CREATE SEQUENCE identity_seq"],
  "SELECT 'public.identity_seq'::regclass = 'identity_seq'::regclass AS same",
);
parity(
  "#462 xid projection and equality",
  ["CREATE TABLE xid_equality(id int)", "INSERT INTO xid_equality VALUES(1)"],
  "SELECT xmin = xmin AS same FROM xid_equality",
);
