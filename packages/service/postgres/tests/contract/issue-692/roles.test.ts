import { expect, test } from "bun:test";
import { Database, Snapshot } from "../../../src/index.ts";
import { errorParity, parity, sequenceParity } from "../helpers.ts";

// #692: CREATE / ALTER / DROP ROLE, role membership, SET ROLE, and recorded GRANT / REVOKE.

const q = (sql: string) => ({ sql, query: true });

const roles = [
  "CREATE ROLE app_ro NOLOGIN",
  "CREATE USER u1 PASSWORD 'secret' CONNECTION LIMIT 3 VALID UNTIL '2030-01-01'",
  "CREATE ROLE r3 SUPERUSER NOINHERIT CREATEDB IN ROLE app_ro",
];

parity(
  "pg_roles lists the built-in roles and the created ones",
  roles,
  "SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolconnlimit, rolpassword, rolvaliduntil FROM pg_roles ORDER BY rolname",
);
parity(
  "pg_authid stores a SCRAM-SHA-256 verifier",
  roles,
  "SELECT rolname, left(rolpassword, 19) AS scheme, rolpassword LIKE 'SCRAM-SHA-256$4096:%$%:%' AS shaped FROM pg_authid WHERE rolname IN ('u1', 'app_ro') ORDER BY 1",
);
parity(
  "pg_user lists login roles",
  roles,
  "SELECT usename, usecreatedb, usesuper, passwd FROM pg_user WHERE usename <> 'postgres' ORDER BY 1",
);
parity(
  "pg_auth_members records IN ROLE with the member's INHERIT",
  [...roles, "GRANT app_ro TO u1 WITH ADMIN OPTION"],
  "SELECT r.rolname AS role, m.rolname AS member, admin_option, inherit_option, set_option, g.rolname AS grantor FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member JOIN pg_roles g ON g.oid = a.grantor ORDER BY 1, 2",
);
errorParity("a role that exists", roles, "CREATE ROLE app_ro", "duplicate_object");
errorParity("PUBLIC is reserved", [], "CREATE ROLE public");
errorParity("pg_ names are reserved", [], "CREATE ROLE pg_foo");
errorParity("conflicting role options", [], "CREATE ROLE r2 LOGIN NOLOGIN", "syntax");
errorParity("a membership loop", roles, "GRANT u1 TO app_ro; GRANT app_ro TO u1");
errorParity("granting a role to itself", roles, "GRANT app_ro TO app_ro");
errorParity("granting a missing role", roles, "GRANT nope TO u1", "undefined_object");

sequenceParity("SET ROLE changes current_user, RESET ROLE restores it", roles, [
  { sql: "GRANT app_ro TO u1" },
  { sql: "SET ROLE u1" },
  q("SELECT current_user, session_user, current_role, user AS u"),
  q("SHOW role"),
  { sql: "SET ROLE app_ro" },
  q("SELECT current_user"),
  { sql: "RESET ROLE" },
  q("SELECT current_user"),
  q("SHOW role"),
  { sql: "SET ROLE u1" },
  { sql: "SET ROLE NONE" },
  q("SELECT current_user"),
]);
sequenceParity("SET LOCAL ROLE ends with the transaction", roles, [
  { sql: "BEGIN" },
  { sql: "SET LOCAL ROLE u1" },
  q("SELECT current_user"),
  { sql: "COMMIT" },
  q("SELECT current_user"),
  { sql: "BEGIN" },
  { sql: "SET ROLE u1" },
  { sql: "ROLLBACK" },
  q("SELECT current_user"),
]);
errorParity("SET ROLE to a missing role", [], "SET ROLE nope", "invalid_parameter");
errorParity("a role without CREATEROLE cannot create roles", [...roles, "SET ROLE u1"], "CREATE ROLE r4");
// the check is against the session user, a superuser here: SET ROLE may pick any role
sequenceParity(
  "a superuser session may SET ROLE to any role",
  [...roles, "SET ROLE u1"],
  [{ sql: "SET ROLE r3" }, q("SELECT current_user, session_user")],
);

sequenceParity("ALTER ROLE options, rename and per-role settings", roles, [
  { sql: "ALTER ROLE u1 RENAME TO u2" },
  { sql: "ALTER ROLE u2 WITH NOLOGIN CONNECTION LIMIT 5" },
  { sql: "ALTER USER u2 CREATEDB" },
  { sql: "ALTER ROLE u2 SET search_path = a, b" },
  { sql: "ALTER ROLE u2 SET work_mem TO '8MB'" },
  q("SELECT rolname, rolcanlogin, rolconnlimit, rolcreatedb, rolconfig FROM pg_roles WHERE rolname = 'u2'"),
  { sql: "ALTER ROLE u2 RESET work_mem" },
  q("SELECT rolconfig FROM pg_roles WHERE rolname = 'u2'"),
]);
errorParity("ALTER a missing role", [], "ALTER ROLE nope NOLOGIN", "undefined_object");
errorParity("the session user cannot be renamed", [], "ALTER ROLE postgres RENAME TO x");
errorParity("DROP a missing role", [], "DROP ROLE nope", "undefined_object");
sequenceParity("DROP ROLE IF EXISTS", roles, [
  { sql: "DROP ROLE IF EXISTS nope, app_ro" },
  q("SELECT rolname FROM pg_roles WHERE rolname IN ('app_ro', 'u1') ORDER BY 1"),
  q("SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'r3'"),
]);
errorParity("the current user cannot be dropped", [], "DROP ROLE postgres");
errorParity("predefined roles cannot be dropped", [], "DROP ROLE pg_monitor");

const grants = [...roles, "CREATE TABLE t (a int)", "CREATE SEQUENCE s"];

sequenceParity("GRANT / REVOKE on tables are recorded in relacl and information_schema", grants, [
  q("SELECT relacl FROM pg_class WHERE relname = 't'"),
  q(
    "SELECT grantor, grantee, privilege_type, is_grantable, with_hierarchy FROM information_schema.table_privileges WHERE table_name = 't' ORDER BY grantee, privilege_type",
  ),
  { sql: "GRANT SELECT, INSERT ON t TO u1 WITH GRANT OPTION" },
  { sql: "GRANT UPDATE ON TABLE t TO PUBLIC" },
  { sql: "GRANT USAGE ON SEQUENCE s TO app_ro" },
  q("SELECT relname, relacl FROM pg_class WHERE relname IN ('t', 's') ORDER BY 1"),
  q(
    "SELECT grantor, grantee, privilege_type, is_grantable FROM information_schema.role_table_grants WHERE table_name = 't' ORDER BY grantee, privilege_type",
  ),
  q(
    "SELECT has_table_privilege('u1', 't', 'SELECT') AS sel, has_table_privilege('u1', 't', 'DELETE') AS del, has_table_privilege('u1', 't', 'UPDATE') AS upd, has_table_privilege('u1', 't', 'insert with grant option') AS ins_grant, has_table_privilege('app_ro', 't', 'SELECT') AS ro_sel, has_table_privilege('t', 'SELECT') AS mine, has_sequence_privilege('app_ro', 's', 'USAGE') AS seq",
  ),
  { sql: "REVOKE GRANT OPTION FOR INSERT ON t FROM u1" },
  { sql: "REVOKE SELECT ON t FROM u1" },
  q("SELECT relacl FROM pg_class WHERE relname = 't'"),
  { sql: "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO app_ro" },
  q("SELECT relacl FROM pg_class WHERE relname = 't'"),
  { sql: "REVOKE ALL ON t FROM u1, app_ro, PUBLIC" },
  q("SELECT relacl FROM pg_class WHERE relname = 't'"),
]);
errorParity("a role with privileges cannot be dropped", [...grants, "GRANT SELECT ON t TO u1"], "DROP ROLE u1");
errorParity("GRANT on a missing table", grants, "GRANT SELECT ON nope TO u1", "undefined_table");
errorParity("GRANT to a missing role", grants, "GRANT SELECT ON t TO nope", "undefined_object");
parity(
  "pg_has_role follows memberships",
  [...roles, "GRANT app_ro TO u1"],
  "SELECT pg_has_role('u1', 'app_ro', 'MEMBER') AS m, pg_has_role('u1', 'app_ro', 'USAGE') AS u, pg_has_role('r3', 'app_ro', 'USAGE') AS r3_usage, pg_has_role('r3', 'app_ro', 'MEMBER') AS r3_member, pg_has_role('app_ro', 'u1', 'MEMBER') AS reverse",
);
parity(
  "pg_get_userbyid names a role",
  roles,
  "SELECT pg_get_userbyid(10) AS su, pg_get_userbyid(oid) AS me FROM pg_roles WHERE rolname = 'u1'",
);
parity(
  "ALTER TABLE OWNER TO sets relowner",
  [...grants, "ALTER TABLE t OWNER TO u1"],
  "SELECT pg_get_userbyid(relowner) AS owner, relacl FROM pg_class WHERE relname = 't'",
);
errorParity("ALTER TABLE OWNER TO a missing role", grants, "ALTER TABLE t OWNER TO nope", "undefined_object");

test("SET SESSION AUTHORIZATION switches the session user (engine; PGlite cannot RESET it)", () => {
  const db = new Database();
  db.exec("CREATE ROLE app_ro NOLOGIN");
  db.exec("CREATE ROLE u1 LOGIN IN ROLE app_ro");
  db.exec("CREATE ROLE other");
  db.exec("SET SESSION AUTHORIZATION u1");
  expect(db.query("SELECT current_user, session_user")).toEqual([{ current_user: "u1", session_user: "u1" }]);
  db.exec("SET ROLE app_ro");
  expect(() => db.exec("SET ROLE other")).toThrow(/permission denied to set role "other"/);
  db.exec("RESET SESSION AUTHORIZATION");
  expect(db.query("SELECT current_user, session_user")).toEqual([
    { current_user: "postgres", session_user: "postgres" },
  ]);
});

test("roles, memberships and grants roll back and survive snapshots", () => {
  const db = new Database();
  db.exec("CREATE TABLE t (a int)");
  db.exec("BEGIN");
  db.exec("CREATE ROLE gone");
  db.exec("ROLLBACK");
  expect(db.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'gone'")).toEqual([{ n: 0 }]);
  db.exec("CREATE ROLE kept LOGIN");
  db.exec("GRANT SELECT ON t TO kept");
  const copy = Snapshot.decode(db.snapshot().encode()).open();
  expect(copy.query("SELECT relacl FROM pg_class WHERE relname = 't'")).toEqual([
    { relacl: "{postgres=arwdDxtm/postgres,kept=r/postgres}" },
  ]);
  expect(copy.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = 'kept'")).toEqual([{ rolcanlogin: true }]);
});

sequenceParity(
  "a pg_dump-style role and grant script loads",
  [],
  [
    { sql: "CREATE ROLE app_owner" },
    { sql: "CREATE ROLE app_ro NOLOGIN" },
    { sql: "CREATE ROLE app_rw WITH LOGIN INHERIT" },
    { sql: "CREATE SCHEMA app" },
    { sql: "ALTER SCHEMA app OWNER TO app_owner" },
    { sql: "CREATE TABLE app.items (id integer NOT NULL, name text)" },
    { sql: "ALTER TABLE app.items OWNER TO app_owner" },
    { sql: "CREATE SEQUENCE app.items_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1" },
    { sql: "ALTER SEQUENCE app.items_id_seq OWNER TO app_owner" },
    { sql: "CREATE TYPE app.mood AS ENUM ('a', 'b')" },
    { sql: "ALTER TYPE app.mood OWNER TO app_owner" },
    { sql: "GRANT USAGE ON SCHEMA app TO app_ro" },
    { sql: "GRANT SELECT ON TABLE app.items TO app_ro" },
    { sql: "GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.items TO app_rw" },
    { sql: "GRANT ALL ON SEQUENCE app.items_id_seq TO app_rw" },
    { sql: "ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app GRANT SELECT ON TABLES TO app_ro" },
    { sql: "GRANT app_ro TO app_rw" },
    q(
      "SELECT relname, pg_get_userbyid(relowner) AS owner, relacl FROM pg_class WHERE relname IN ('items', 'items_id_seq') ORDER BY 1",
    ),
  ],
);
errorParity("OWNER TO a missing role", ["CREATE SCHEMA app"], "ALTER SCHEMA app OWNER TO nobody", "undefined_object");
