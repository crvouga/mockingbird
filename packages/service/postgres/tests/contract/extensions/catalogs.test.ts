import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { errorParity, parity, parityTyped, sequenceParity, setupBoth } from "../helpers.ts";

// pg_available_extensions / pg_extension consistent with CREATE / DROP EXTENSION (issue #334).
//
// What is comparable: the PGlite oracle is built with exactly the contrib extensions the test
// adapter loads (fuzzystrmatch, pgcrypto, pg_trgm and pgvector's vector) plus the built-in plpgsql,
// and those are the extensions this engine implements, so the availability views are compared in full. A stock PostgreSQL
// server lists every contrib control file it ships (~50 more); none of those exists here, which
// the "unavailable extension" tests pin. Object identifiers are never compared.

const AVAILABLE = "SELECT name, default_version, installed_version, comment FROM pg_available_extensions ORDER BY name";
const INSTALLED =
  "SELECT e.extname, e.extversion, n.nspname, e.extrelocatable, e.extowner, e.extconfig, e.extcondition " +
  "FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY e.extname";
const VERSIONS =
  "SELECT name, version, installed, superuser, trusted, relocatable, schema, requires, comment " +
  "FROM pg_available_extension_versions ORDER BY name, version";

// Behavior 1: the availability query runs and the catalogs reflect installation state.
parity("pg_available_extensions lists exactly the extensions that can be installed", [], AVAILABLE);

parity(
  "an unavailable extension yields zero rows, not an error",
  ["CREATE TABLE kv (id integer, value text)"],
  "SELECT default_version FROM pg_available_extensions WHERE name = 'hypopg'",
);

parity(
  "unavailable extensions are absent from every extension catalog",
  [],
  `SELECT (SELECT count(*) FROM pg_available_extensions WHERE name IN ('hypopg', 'postgis', 'hstore', 'uuid-ossp')) AS available,
          (SELECT count(*) FROM pg_available_extension_versions WHERE name IN ('hypopg', 'postgis', 'hstore')) AS versions,
          (SELECT count(*) FROM pg_extension WHERE extname IN ('hypopg', 'postgis', 'hstore')) AS installed`,
);

parity("pg_extension starts with the built-in plpgsql only", [], INSTALLED);

parity("pg_available_extension_versions lists every installable version", [], VERSIONS);

parityTyped(
  "pg_available_extensions column types",
  [],
  "SELECT name, default_version, installed_version, comment FROM pg_available_extensions WHERE name = 'plpgsql'",
);

parityTyped(
  "pg_extension column types",
  [],
  "SELECT extname, extowner, extrelocatable, extversion, extconfig, extcondition FROM pg_extension WHERE extname = 'plpgsql'",
);

sequenceParity(
  "CREATE EXTENSION and DROP EXTENSION update installed_version and pg_extension",
  [],
  [
    { sql: "CREATE EXTENSION pgcrypto" },
    { sql: AVAILABLE, query: true },
    { sql: INSTALLED, query: true },
    { sql: VERSIONS, query: true },
    { sql: "CREATE EXTENSION pg_trgm" },
    { sql: AVAILABLE, query: true },
    { sql: INSTALLED, query: true },
    { sql: "SELECT extname FROM pg_catalog.pg_extension WHERE oid > 0 ORDER BY 1", query: true },
    { sql: "DROP EXTENSION pgcrypto" },
    { sql: AVAILABLE, query: true },
    { sql: INSTALLED, query: true },
    { sql: "SELECT encode(digest('a', 'sha1'), 'hex')", query: true },
    { sql: "DROP EXTENSION pg_trgm" },
    { sql: AVAILABLE, query: true },
    { sql: INSTALLED, query: true },
    { sql: VERSIONS, query: true },
  ],
);

sequenceParity(
  "WITH SCHEMA and VERSION are recorded in the catalogs",
  ["CREATE SCHEMA ext"],
  [
    { sql: "CREATE EXTENSION pgcrypto WITH SCHEMA ext VERSION '1.3'" },
    { sql: 'CREATE EXTENSION pg_trgm SCHEMA ext VERSION "1.5"' },
    { sql: AVAILABLE, query: true },
    { sql: INSTALLED, query: true },
    { sql: VERSIONS, query: true },
    { sql: "SELECT encode(ext.digest('a', 'sha1'), 'hex') AS d, ext.similarity('abc', 'abd') > 0 AS s", query: true },
    { sql: "DROP EXTENSION pgcrypto, pg_trgm" },
    { sql: "CREATE EXTENSION pgcrypto" },
    { sql: AVAILABLE, query: true },
    { sql: INSTALLED, query: true },
  ],
);

sequenceParity(
  "dropping the schema an extension lives in removes the extension",
  ["CREATE SCHEMA ext", "CREATE EXTENSION pg_trgm WITH SCHEMA ext"],
  [
    { sql: INSTALLED, query: true },
    { sql: "DROP SCHEMA ext CASCADE" },
    { sql: INSTALLED, query: true },
    { sql: AVAILABLE, query: true },
    { sql: "CREATE EXTENSION pg_trgm" },
    { sql: INSTALLED, query: true },
  ],
);

// Behavior 2: invalid targets fail with PostgreSQL's errors.
errorParity("CREATE EXTENSION of an unavailable extension fails", [], "CREATE EXTENSION hypopg", "unsupported", {
  messageTier: "A",
});

errorParity(
  "IF NOT EXISTS does not hide an unavailable extension",
  [],
  "CREATE EXTENSION IF NOT EXISTS hypopg",
  "unsupported",
  { messageTier: "A" },
);

errorParity("extension names are case-sensitive once quoted", [], 'CREATE EXTENSION "PGCRYPTO"', "unsupported", {
  messageTier: "A",
});

errorParity(
  "CREATE EXTENSION of an installed extension fails",
  ["CREATE EXTENSION pgcrypto"],
  "CREATE EXTENSION pgcrypto",
  "duplicate_object",
  { messageTier: "A" },
);

errorParity(
  "CREATE EXTENSION of the built-in plpgsql fails as already installed",
  [],
  "CREATE EXTENSION plpgsql",
  "duplicate_object",
  { messageTier: "A" },
);

errorParity(
  "a version PostgreSQL has no script for is rejected",
  [],
  "CREATE EXTENSION pg_trgm VERSION '9.9'",
  "invalid_parameter",
  { messageTier: "A" },
);

errorParity(
  "a missing target schema is rejected",
  [],
  "CREATE EXTENSION pg_trgm WITH SCHEMA nosuch",
  "undefined_object",
  { messageTier: "A" },
);

errorParity(
  "DROP EXTENSION of an extension that is not installed fails",
  [],
  "DROP EXTENSION pgcrypto",
  "undefined_object",
  {
    messageTier: "A",
  },
);

errorParity("DROP EXTENSION of an unavailable extension fails", [], "DROP EXTENSION hypopg", "undefined_object", {
  messageTier: "A",
});

sequenceParity(
  "IF NOT EXISTS and IF EXISTS are no-ops, and a failed statement installs or drops nothing",
  [],
  [
    { sql: "CREATE EXTENSION IF NOT EXISTS pgcrypto" },
    { sql: "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public" },
    { sql: "CREATE EXTENSION IF NOT EXISTS plpgsql" },
    { sql: "CREATE EXTENSION IF NOT EXISTS plpgsql WITH SCHEMA pg_catalog" },
    { sql: "CREATE EXTENSION pg_trgm VERSION '9.9'" },
    { sql: "CREATE EXTENSION pg_trgm WITH SCHEMA nosuch" },
    { sql: INSTALLED, query: true },
    { sql: "DROP EXTENSION IF EXISTS hypopg" },
    { sql: "DROP EXTENSION IF EXISTS pg_trgm" },
    { sql: "DROP EXTENSION pgcrypto, pg_trgm" },
    { sql: INSTALLED, query: true },
    { sql: "DROP EXTENSION IF EXISTS pgcrypto, pg_trgm, hypopg" },
    { sql: "DROP EXTENSION IF EXISTS pgcrypto" },
    { sql: INSTALLED, query: true },
    { sql: AVAILABLE, query: true },
  ],
);

errorParity(
  "DROP EXTENSION is refused while an index uses the extension's operator class",
  [
    "CREATE EXTENSION pg_trgm",
    "CREATE TABLE kv (id integer, value text)",
    "CREATE INDEX kv_trgm ON kv USING gin (value gin_trgm_ops)",
  ],
  "DROP EXTENSION pg_trgm",
  undefined,
  { messageTier: "A" },
);

errorParity(
  "DROP EXTENSION is refused while a column default uses one of its functions",
  ["CREATE EXTENSION pgcrypto", "CREATE TABLE kv (id integer, hash bytea DEFAULT digest('x', 'sha256'))"],
  "DROP EXTENSION pgcrypto RESTRICT",
  undefined,
  { messageTier: "A" },
);

errorParity(
  "a function an extension installed cannot be dropped on its own",
  ["CREATE EXTENSION pgcrypto"],
  "DROP FUNCTION digest(text, text)",
  undefined,
  { messageTier: "A" },
);

sequenceParity(
  "a refused DROP FUNCTION leaves the extension installed and usable",
  ["CREATE EXTENSION pg_trgm"],
  [
    { sql: "DROP FUNCTION similarity(text, text)" },
    { sql: "DROP FUNCTION IF EXISTS similarity(text, text)" },
    { sql: INSTALLED, query: true },
    { sql: "SELECT similarity('abc', 'abd') > 0 AS usable", query: true },
  ],
);

sequenceParity(
  "DROP EXTENSION ... CASCADE removes the objects that depend on the extension",
  [
    "CREATE EXTENSION pgcrypto",
    "CREATE EXTENSION pg_trgm",
    `CREATE TABLE kv (
       id integer, value text CHECK (digest(value, 'sha1') IS NOT NULL),
       hash bytea DEFAULT digest('x', 'sha256'), fixed bytea GENERATED ALWAYS AS (digest('a', 'sha1')) STORED
     )`,
    "CREATE VIEW kv_hash AS SELECT digest('a', 'sha1') AS d",
    "CREATE VIEW kv_similar AS SELECT id FROM kv WHERE value <% 'abc'",
    "CREATE INDEX kv_expr ON kv (digest(value, 'sha1'))",
    "CREATE INDEX kv_part ON kv (id) WHERE similarity(value, 'a') > 0.5",
    "CREATE INDEX kv_trgm ON kv USING gin (value gin_trgm_ops)",
    "CREATE INDEX kv_plain ON kv (value)",
    "INSERT INTO kv (id, value) VALUES (1, 'a')",
  ],
  [
    { sql: "DROP EXTENSION pgcrypto" },
    { sql: "DROP EXTENSION pg_trgm" },
    { sql: INSTALLED, query: true },
    { sql: "DROP EXTENSION pgcrypto, pg_trgm CASCADE" },
    { sql: INSTALLED, query: true },
    {
      sql: "SELECT column_name, column_default, is_generated FROM information_schema.columns WHERE table_name = 'kv' ORDER BY ordinal_position",
      query: true,
    },
    {
      sql: "SELECT con.conname FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid WHERE c.relname = 'kv' AND con.contype = 'c'",
      query: true,
    },
    { sql: "SELECT viewname FROM pg_views WHERE viewname LIKE 'kv%' ORDER BY 1", query: true },
    { sql: "SELECT indexname FROM pg_indexes WHERE tablename = 'kv' ORDER BY 1", query: true },
    { sql: "INSERT INTO kv (id, value) VALUES (2, 'b')" },
    { sql: "SELECT * FROM kv ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

// Behavior 3: repeated reconciliation, rollback and snapshot reload keep the metadata.
sequenceParity(
  "repeated reconciliation converges",
  [],
  [
    { sql: "CREATE EXTENSION IF NOT EXISTS pg_trgm" },
    { sql: "CREATE EXTENSION IF NOT EXISTS pg_trgm" },
    { sql: "DROP EXTENSION IF EXISTS pgcrypto" },
    { sql: "DROP EXTENSION IF EXISTS pgcrypto" },
    {
      sql: "SELECT name, installed_version FROM pg_available_extensions WHERE name IN ('pg_trgm', 'pgcrypto', 'hypopg') ORDER BY 1",
      query: true,
    },
    { sql: INSTALLED, query: true },
  ],
);

sequenceParity(
  "ROLLBACK and ROLLBACK TO SAVEPOINT restore installation state",
  ["CREATE EXTENSION pg_trgm"],
  [
    { sql: "BEGIN" },
    { sql: "CREATE EXTENSION pgcrypto VERSION '1.3'" },
    { sql: AVAILABLE, query: true },
    { sql: "ROLLBACK" },
    { sql: AVAILABLE, query: true },
    { sql: INSTALLED, query: true },
    { sql: "BEGIN" },
    { sql: "DROP EXTENSION pg_trgm" },
    { sql: "SAVEPOINT dropped" },
    { sql: "CREATE EXTENSION pg_trgm VERSION '1.4'" },
    { sql: "CREATE EXTENSION pgcrypto" },
    { sql: INSTALLED, query: true },
    { sql: "ROLLBACK TO SAVEPOINT dropped" },
    { sql: INSTALLED, query: true },
    { sql: "ROLLBACK" },
    { sql: INSTALLED, query: true },
    { sql: AVAILABLE, query: true },
    { sql: "SELECT similarity('abc', 'abd') > 0 AS still_installed", query: true },
    { sql: "BEGIN" },
    { sql: "DROP EXTENSION pg_trgm" },
    { sql: "COMMIT" },
    { sql: INSTALLED, query: true },
  ],
);

matrixBoth("installed extensions, their schemas and versions survive a snapshot reload", async (memory, postgres) => {
  await setupBoth(memory, postgres, [
    "CREATE SCHEMA ext",
    "CREATE EXTENSION pgcrypto WITH SCHEMA ext VERSION '1.3'",
    "CREATE EXTENSION pg_trgm",
  ]);
  memory.restore(memory.snapshot());
  for (const sql of [AVAILABLE, INSTALLED, VERSIONS]) expectParity(await memory.query(sql), await postgres.query(sql));
  const drop = "DROP EXTENSION pg_trgm";
  expectParity(await memory.exec(drop), await postgres.exec(drop), { ignoreWriteCounters: true });
  memory.restore(memory.snapshot());
  for (const sql of [AVAILABLE, INSTALLED]) expectParity(await memory.query(sql), await postgres.query(sql));
  const use = "SELECT encode(ext.digest('a', 'sha1'), 'hex') AS d";
  expectParity(await memory.query(use), await postgres.query(use));
});

test("a snapshot written before extension versions were recorded reads as the default version", () => {
  const db = new Database();
  try {
    db.exec("CREATE EXTENSION pgcrypto");
    // An extension at its default version stores nothing beyond its functions, which is all
    // an older snapshot holds: the catalogs derive the rest.
    expect(new TextDecoder().decode(db.snapshot().encode())).not.toContain("extensionVersion");
    const reopened = db.snapshot().open();
    expect(
      reopened.query("SELECT name, installed_version FROM pg_available_extensions WHERE name = 'pgcrypto'"),
    ).toEqual([{ name: "pgcrypto", installed_version: "1.4" }]);
    reopened.close();
  } finally {
    db.close();
  }
});

test("DROP EXTENSION plpgsql fails loudly: the language is built in", () => {
  const db = new Database();
  try {
    // PostgreSQL can drop plpgsql and recreate it; here the language cannot be removed, so the
    // statement is refused rather than leaving pg_extension out of step with what runs.
    expect(() => db.exec("DROP EXTENSION plpgsql")).toThrow(expect.objectContaining({ sqlState: "0A000" }));
    expect(db.query("SELECT extname, extversion FROM pg_extension")).toEqual([
      { extname: "plpgsql", extversion: "1.0" },
    ]);
  } finally {
    db.close();
  }
});
