import { describe, expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { parity, parityTyped, queryErrorParity, sequenceParity } from "../helpers.ts";

// #725: connection-introspection functions, regrole, privilege inquiry functions, is_superuser, and
// the catalogs pg_db_role_setting, pg_proc.proconfig, pg_rewrite, pg_operator, pg_stat_all_tables /
// pg_stat_sys_tables, plus advisory locks in pg_locks and the _shared lock functions.

const q = (sql: string) => ({ sql, query: true });

/** The same column names (and order) in both engines. */
const sameColumns = (relation: string) =>
  matrixBoth(`#725 ${relation} has PostgreSQL's columns`, async (memory, postgres) => {
    const sql = `SELECT * FROM pg_catalog.${relation} LIMIT 0`;
    const a = await memory.query(sql);
    const b = await postgres.query(sql);
    expect(a.ok, a.error?.message).toBe(true);
    expect(a.columns).toEqual(b.columns);
  });

describe("#725 inet_server_addr / inet_server_port / inet_client_addr / inet_client_port", () => {
  // In-process there is no socket, as for a Unix-socket connection: the server side is NULL.
  parityTyped(
    "#725 inet_server_addr() and inet_server_port() are NULL without a TCP socket",
    [],
    "SELECT inet_server_addr() AS a, inet_server_port() AS p",
  );
  parity(
    "#725 the four functions are inet / integer",
    [],
    `SELECT pg_typeof(inet_server_addr())::text AS sa, pg_typeof(inet_server_port())::text AS sp,
            pg_typeof(inet_client_addr())::text AS ca, pg_typeof(inet_client_port())::text AS cp`,
  );
  // PGlite reports 127.0.0.1 / 5432 for the client of its in-process connection; that is an artifact
  // of its emulated socket. The engine has no client socket, so it answers NULL (best guess, as for a
  // Unix-socket connection).
  test("#725 the engine on its own has no client address", () => {
    const db = new Database();
    expect(db.query("SELECT inet_client_addr() AS a, inet_client_port() AS p")).toEqual([{ a: null, p: null }]);
  });
});

describe("#725 regrole and to_regrole", () => {
  parityTyped(
    "#725 text -> regrole -> oid / text",
    ["CREATE ROLE r725"],
    `SELECT 'postgres'::regrole AS a, 'postgres'::regrole::oid AS b, 'pg_monitor'::regrole::oid::int AS c,
            '10'::regrole AS d, 10::oid::regrole AS e, 'postgres'::regrole::text AS f, '"postgres"'::regrole AS g,
            'R725'::regrole AS h, 99999::oid::regrole AS i, '-'::regrole::oid AS j`,
  );
  parity(
    "#725 regrole compares with an oid",
    [],
    "SELECT rolname FROM pg_roles WHERE oid = 'postgres'::regrole AND 'postgres'::regrole = 10",
  );
  parityTyped(
    "#725 to_regrole",
    [],
    "SELECT to_regrole('postgres') AS a, to_regrole('postgres')::oid AS b, to_regrole('nope') AS c, to_regrole('a.b') AS d",
  );
  parity("#725 pg_typeof regrole", [], "SELECT pg_typeof('postgres'::regrole)::text AS t");
  queryErrorParity("#725 an unknown role", [], "SELECT 'nope'::regrole");
  queryErrorParity("#725 a qualified role name", [], "SELECT 'a.b'::regrole");
});

describe("#725 current_query, pg_current_xact_id_if_assigned", () => {
  parity("#725 current_query() is the statement text", [], "SELECT current_query() AS q");
  sequenceParity(
    "#725 pg_current_xact_id_if_assigned is NULL until the transaction writes",
    ["CREATE TABLE x725 (a int)"],
    [
      q("SELECT pg_current_xact_id_if_assigned() AS x"),
      { sql: "BEGIN" },
      q("SELECT pg_current_xact_id_if_assigned() AS x"),
      { sql: "INSERT INTO x725 VALUES (1)" },
      q(
        `SELECT pg_current_xact_id_if_assigned() IS NOT NULL AS assigned,
                pg_typeof(pg_current_xact_id_if_assigned())::text AS t,
                pg_current_xact_id_if_assigned() = pg_current_xact_id() AS same`,
      ),
      { sql: "COMMIT" },
      q("SELECT pg_current_xact_id_if_assigned() AS x"),
      { sql: "BEGIN" },
      q("SELECT pg_current_xact_id() IS NOT NULL AS taken"),
      q("SELECT pg_current_xact_id_if_assigned() IS NOT NULL AS assigned"),
      { sql: "ROLLBACK" },
    ],
  );
});

describe("#725 has_database_privilege / has_function_privilege", () => {
  parity(
    "#725 has_database_privilege(database, privilege)",
    [],
    `SELECT has_database_privilege('postgres', 'CONNECT') AS a, has_database_privilege('postgres', 'CONNECT, TEMP') AS b,
            has_database_privilege('postgres', 'TEMPORARY') AS c, has_database_privilege('postgres', 'create with grant option') AS d,
            has_database_privilege((SELECT oid FROM pg_database WHERE datname = 'postgres'), 'CONNECT') AS e`,
  );
  parity(
    "#725 has_database_privilege(user, database, privilege)",
    ["CREATE ROLE dbp725"],
    `SELECT has_database_privilege('dbp725', 'postgres', 'CONNECT') AS c, has_database_privilege('dbp725', 'postgres', 'CREATE') AS cr,
            has_database_privilege('dbp725', 'postgres', 'TEMP') AS t, has_database_privilege('postgres', 'postgres', 'CREATE') AS su,
            has_database_privilege((SELECT oid FROM pg_roles WHERE rolname = 'dbp725'), 'postgres', 'CONNECT') AS byoid`,
  );
  queryErrorParity(
    "#725 has_database_privilege of an unknown database",
    [],
    "SELECT has_database_privilege('nope', 'CONNECT')",
  );
  queryErrorParity(
    "#725 has_database_privilege of a table privilege",
    [],
    "SELECT has_database_privilege('postgres', 'select')",
  );
  parity(
    "#725 has_function_privilege of a builtin",
    [],
    `SELECT has_function_privilege('now()', 'EXECUTE') AS a, has_function_privilege('postgres', 'now()', 'execute') AS b,
            has_function_privilege('pg_catalog.lower(text)', 'EXECUTE') AS c`,
  );
  sequenceParity(
    "#725 has_function_privilege follows REVOKE / GRANT EXECUTE",
    ["CREATE ROLE fp725", "CREATE FUNCTION f725(int) RETURNS int LANGUAGE sql AS 'SELECT 1'"],
    [
      q(
        "SELECT has_function_privilege('fp725', 'f725(int)', 'execute') AS a, has_function_privilege('fp725', 'f725(integer)', 'EXECUTE WITH GRANT OPTION') AS b",
      ),
      { sql: "REVOKE EXECUTE ON FUNCTION f725(int) FROM PUBLIC" },
      q("SELECT has_function_privilege('fp725', 'f725(int)', 'execute') AS a"),
      q("SELECT has_function_privilege('postgres', 'f725(int)', 'execute') AS a"),
      { sql: "GRANT EXECUTE ON FUNCTION f725(int) TO fp725" },
      q("SELECT has_function_privilege('fp725', 'f725(int)', 'execute') AS a"),
      q(
        "SELECT has_function_privilege('fp725', (SELECT oid FROM pg_proc WHERE proname = 'f725'), 'execute') AS a, has_function_privilege((SELECT oid FROM pg_proc WHERE proname = 'f725'), 'execute') AS b",
      ),
      { sql: "CREATE ROLE other725" },
      q("SELECT has_function_privilege('other725', 'f725(int)', 'execute') AS a"),
    ],
  );
  queryErrorParity(
    "#725 has_function_privilege of an unknown function",
    [],
    "SELECT has_function_privilege('nope()', 'EXECUTE')",
  );
  queryErrorParity("#725 has_function_privilege of SELECT", [], "SELECT has_function_privilege('now()', 'SELECT')");
});

describe("#725 is_superuser", () => {
  sequenceParity(
    "#725 current_setting('is_superuser') and SHOW is_superuser follow SET ROLE",
    ["CREATE ROLE su725"],
    [
      q("SELECT current_setting('is_superuser') AS s, current_setting('is_superuser', true) AS m"),
      q("SHOW is_superuser"),
      { sql: "SET ROLE su725" },
      q("SELECT current_setting('is_superuser') AS s"),
      q("SHOW is_superuser"),
      { sql: "RESET ROLE" },
      q("SELECT current_setting('is_superuser') AS s"),
      // not listed in pg_settings (GUC_NO_SHOW_ALL)
      q("SELECT count(*) AS n FROM pg_settings WHERE name = 'is_superuser'"),
    ],
  );
});

describe("#725 pg_db_role_setting", () => {
  sameColumns("pg_db_role_setting");
  sequenceParity(
    "#725 ALTER ROLE / ALTER DATABASE ... SET populate pg_db_role_setting",
    ["CREATE ROLE rs725"],
    [
      q("SELECT count(*) AS n FROM pg_db_role_setting"),
      { sql: "ALTER ROLE rs725 SET work_mem = '8MB'" },
      { sql: "ALTER ROLE rs725 IN DATABASE postgres SET search_path = a, b" },
      { sql: "ALTER DATABASE postgres SET statement_timeout = '5s'" },
      q(
        "SELECT setdatabase, setrole::regrole::text AS r, setconfig FROM pg_db_role_setting ORDER BY setdatabase, setrole",
      ),
      { sql: "ALTER ROLE rs725 SET lock_timeout TO 1000" },
      { sql: "ALTER ROLE rs725 RESET work_mem" },
      { sql: "ALTER ROLE ALL SET work_mem = '1MB'" },
      q(
        "SELECT setdatabase, setrole::regrole::text AS r, setconfig FROM pg_db_role_setting ORDER BY setdatabase, setrole",
      ),
      { sql: "ALTER ROLE rs725 RESET ALL" },
      { sql: "ALTER DATABASE postgres RESET statement_timeout" },
      { sql: "ALTER ROLE ALL RESET work_mem" },
      q(
        "SELECT setdatabase, setrole::regrole::text AS r, setconfig FROM pg_db_role_setting ORDER BY setdatabase, setrole",
      ),
      { sql: "ALTER ROLE rs725 IN DATABASE postgres RESET ALL" },
      q("SELECT count(*) AS n FROM pg_db_role_setting"),
    ],
  );
});

describe("#725 pg_proc.proconfig", () => {
  parity(
    "#725 CREATE FUNCTION ... SET is pg_proc.proconfig",
    [
      "CREATE FUNCTION pc725() RETURNS int LANGUAGE sql SET search_path = public SET work_mem = '1MB' AS 'SELECT 1'",
      "CREATE FUNCTION pn725() RETURNS int LANGUAGE sql AS 'SELECT 1'",
    ],
    "SELECT proname, proconfig FROM pg_proc WHERE proname IN ('pc725', 'pn725') ORDER BY proname",
  );
  parity(
    "#725 proconfig is NULL for a builtin",
    [],
    "SELECT proconfig IS NULL AS n, pg_typeof(proconfig)::text AS t FROM pg_proc WHERE proname = 'now'",
  );
});

describe("#725 pg_rewrite", () => {
  sameColumns("pg_rewrite");
  parity(
    "#725 a view has its _RETURN rule",
    [
      "CREATE TABLE rw725 (a int)",
      "CREATE VIEW vw725 AS SELECT a FROM rw725",
      "CREATE MATERIALIZED VIEW mv725 AS SELECT 1 AS a",
    ],
    `SELECT rulename, ev_class::regclass::text AS c, ev_type, ev_enabled, is_instead
     FROM pg_rewrite WHERE ev_class IN ('vw725'::regclass, 'mv725'::regclass, 'rw725'::regclass) ORDER BY 2`,
  );
  parity(
    "#725 pg_rewrite joins pg_class",
    ["CREATE VIEW vj725 AS SELECT 1 AS a"],
    `SELECT c.relname, r.rulename FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class
     WHERE c.relnamespace = 'public'::regnamespace ORDER BY 1`,
  );
  sequenceParity(
    "#725 DROP VIEW removes the rule",
    ["CREATE VIEW vd725 AS SELECT 1 AS a"],
    [
      q("SELECT count(*) AS n FROM pg_rewrite WHERE ev_class = 'vd725'::regclass"),
      { sql: "DROP VIEW vd725" },
      q("SELECT count(*) AS n FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class WHERE c.relname = 'vd725'"),
    ],
  );
});

describe("#725 pg_operator", () => {
  sameColumns("pg_operator");
  parity(
    "#725 the int4 + operators",
    [],
    `SELECT oid, oprname, oprleft::regtype::text AS l, oprright::regtype::text AS r, oprresult::regtype::text AS res,
            oprkind, oprcode::text AS code, oprnamespace, oprowner, oprcom, oprnegate, oprcanmerge, oprcanhash,
            oprrest::text AS rest, oprjoin::text AS j
     FROM pg_operator WHERE oprname = '+' AND oprleft = 'int4'::regtype AND oprright IN ('int2'::regtype, 'int4'::regtype, 'int8'::regtype)
     ORDER BY oid`,
  );
  parity(
    "#725 text = and <> with their commutator and negator",
    [],
    `SELECT oid, oprname, oprresult::regtype::text AS res, oprcode::text AS code, oprcom, oprnegate, oprcanmerge, oprcanhash,
            oprrest::text AS rest, oprjoin::text AS j
     FROM pg_operator WHERE oprname IN ('=', '<>') AND oprleft = 'text'::regtype AND oprright = 'text'::regtype ORDER BY oid`,
  );
  parity(
    "#725 prefix operators have no left operand",
    [],
    `SELECT oid, oprname, oprkind, oprleft, oprright::regtype::text AS r FROM pg_operator
     WHERE oprkind = 'l' AND oprright IN ('int4'::regtype, 'int8'::regtype, 'numeric'::regtype) ORDER BY oid`,
  );
  parity(
    "#725 the jsonb containment and existence operators",
    [],
    `SELECT oid, oprname, oprright::regtype::text AS r, oprresult::regtype::text AS res, oprcode::text AS code
     FROM pg_operator WHERE oprleft = 'jsonb'::regtype AND oprname IN ('@>', '<@', '?', '?|', '?&', '->', '->>') ORDER BY oid`,
  );
  parity(
    "#725 the operator of an expression resolves by name and operand types",
    [],
    `SELECT o.oprcode::text AS code FROM pg_operator o
     WHERE o.oprname = '||' AND o.oprleft = 'text'::regtype AND o.oprright = 'text'::regtype`,
  );
});

describe("#725 pg_stat_all_tables / pg_stat_sys_tables / pg_stat_user_tables", () => {
  sameColumns("pg_stat_all_tables");
  sameColumns("pg_stat_sys_tables");
  sameColumns("pg_stat_user_tables");
  parity(
    "#725 a user table is in pg_stat_all_tables and pg_stat_user_tables, not pg_stat_sys_tables",
    ["CREATE TABLE st725 (a int)", "INSERT INTO st725 VALUES (1), (2)", "ANALYZE st725"],
    `SELECT relid::regclass::text AS r, schemaname, relname, n_live_tup,
            (SELECT count(*) FROM pg_stat_user_tables u WHERE u.relid = a.relid) AS in_user,
            (SELECT count(*) FROM pg_stat_sys_tables s WHERE s.relid = a.relid) AS in_sys
     FROM pg_stat_all_tables a WHERE relname = 'st725'`,
  );
  parity(
    "#725 the system catalogs are in pg_stat_sys_tables",
    [],
    `SELECT schemaname, relname, relid = 'pg_class'::regclass AS same FROM pg_stat_sys_tables WHERE relname IN ('pg_class', 'pg_proc') ORDER BY 2`,
  );
  parity(
    "#725 pg_stat_all_tables lists the catalogs too",
    [],
    "SELECT count(*) > 5 AS many FROM pg_stat_all_tables WHERE schemaname = 'pg_catalog'",
  );
});

describe("#725 roles and event triggers (already supported)", () => {
  sequenceParity(
    "#725 CREATE ROLE ... CREATEROLE shows in pg_roles.rolcreaterole",
    [],
    [
      { sql: "CREATE ROLE cr725 CREATEROLE" },
      { sql: "CREATE ROLE nc725" },
      q("SELECT rolname, rolcreaterole FROM pg_roles WHERE rolname IN ('cr725', 'nc725') ORDER BY 1"),
      { sql: "ALTER ROLE nc725 CREATEROLE" },
      q("SELECT rolname, rolcreaterole FROM pg_roles WHERE rolname = 'nc725'"),
    ],
  );
  sequenceParity(
    "#725 CREATE EVENT TRIGGER",
    ["CREATE FUNCTION et725() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$"],
    [
      { sql: "CREATE EVENT TRIGGER e725 ON ddl_command_start EXECUTE FUNCTION et725()" },
      q("SELECT evtname, evtevent, evtenabled FROM pg_event_trigger"),
    ],
  );
});

describe("#725 advisory locks", () => {
  const lockRows = `SELECT locktype, database = (SELECT oid FROM pg_database WHERE datname = current_database()) AS db,
                           relation, classid, objid, objsubid, mode, granted, pid = pg_backend_pid() AS mine
                    FROM pg_locks WHERE locktype = 'advisory' ORDER BY classid, objid, objsubid, mode`;
  sequenceParity(
    "#725 pg_locks lists advisory locks",
    [],
    [
      q("SELECT pg_advisory_lock(42)"),
      q("SELECT pg_advisory_lock(42)"),
      q("SELECT pg_advisory_lock(1, 2)"),
      q("SELECT pg_advisory_lock(-1)"),
      q("SELECT pg_advisory_lock(4294967298)"),
      q("SELECT pg_advisory_lock_shared(7)"),
      q("SELECT pg_advisory_lock_shared(-3, -4)"),
      q(lockRows),
      q("SELECT pg_advisory_unlock(42) AS a, pg_advisory_unlock(42) AS b, pg_advisory_unlock(42) AS c"),
      q("SELECT pg_advisory_unlock(7) AS exclusive_not_held, pg_advisory_unlock_shared(7) AS shared_held"),
      q("SELECT pg_advisory_unlock_shared(1, 2) AS wrong_mode, pg_advisory_unlock(1, 2) AS right_mode"),
      q(lockRows),
      q("SELECT pg_advisory_unlock_all()"),
      q(lockRows),
    ],
  );
  parity(
    "#725 pg_advisory_unlock of a lock not held is false",
    [],
    "SELECT pg_advisory_unlock(43) AS a, pg_advisory_unlock(1, 1) AS b, pg_advisory_unlock_shared(43) AS c",
  );
  sequenceParity(
    "#725 the try and _shared variants",
    [],
    [
      q(
        `SELECT pg_try_advisory_lock(1) AS a, pg_try_advisory_lock_shared(1) AS b, pg_try_advisory_lock(2, 3) AS c,
              pg_try_advisory_lock_shared(2, 3) AS d`,
      ),
      q(lockRows),
      q("SELECT pg_advisory_unlock_all()"),
      q(lockRows),
    ],
  );
  sequenceParity(
    "#725 transaction-level advisory locks end with the transaction",
    [],
    [
      { sql: "BEGIN" },
      q("SELECT pg_advisory_xact_lock(10)"),
      q("SELECT pg_advisory_xact_lock_shared(11)"),
      q("SELECT pg_advisory_xact_lock(12, 13)"),
      q("SELECT pg_advisory_xact_lock_shared(14, 15)"),
      q("SELECT pg_try_advisory_xact_lock(16) AS a, pg_try_advisory_xact_lock_shared(17) AS b"),
      q("SELECT pg_try_advisory_xact_lock(18, 19) AS a, pg_try_advisory_xact_lock_shared(20, 21) AS b"),
      q("SELECT pg_advisory_lock(30)"),
      q(lockRows),
      // a transaction-level lock is not released by pg_advisory_unlock
      q("SELECT pg_advisory_unlock(10) AS a"),
      { sql: "COMMIT" },
      q(lockRows),
      { sql: "BEGIN" },
      q("SELECT pg_advisory_xact_lock(40)"),
      { sql: "ROLLBACK" },
      q(lockRows),
      q("SELECT pg_advisory_unlock(30) AS a"),
    ],
  );
  sequenceParity(
    "#725 a session-level lock taken in a rolled-back transaction stays",
    [],
    [
      { sql: "BEGIN" },
      q("SELECT pg_advisory_lock(50)"),
      { sql: "ROLLBACK" },
      q(lockRows),
      q("SELECT pg_advisory_unlock(50) AS a"),
    ],
  );
  parity(
    "#725 the _shared functions return void",
    [],
    `SELECT pg_typeof(pg_advisory_lock_shared(1))::text AS a, pg_typeof(pg_advisory_unlock_shared(1))::text AS b`,
  );
  matrixBoth("#725 NULL keys", async (memory, postgres) => {
    const sql =
      "SELECT pg_advisory_lock_shared(NULL::bigint) IS NULL AS a, pg_try_advisory_lock_shared(NULL::int, 1) AS b";
    expectParity(await memory.query(sql), await postgres.query(sql), { ignoreWriteCounters: true });
  });
});
