import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { errorParity, parity, queryErrorParity, sequenceParity } from "../helpers.ts";

// #682: CREATE PROCEDURE / CALL, SQL-standard BEGIN ATOMIC bodies, and transaction control in
// procedures and DO blocks. Every case runs against PostgreSQL (PGlite) too.

const C = ["CREATE TABLE c (a int)", "INSERT INTO c VALUES (4), (5)"];

sequenceParity(
  "the issue's reproduction: BEGIN ATOMIC function, plpgsql procedure and CALL",
  C,
  [
    { sql: "CREATE FUNCTION f9(a int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT a + 1; END" },
    { sql: "SELECT f9(1) AS begin_atomic", query: true },
    { sql: "CREATE PROCEDURE p1(n int) LANGUAGE plpgsql AS $$ BEGIN INSERT INTO c VALUES (n); END $$" },
    { sql: "CALL p1(9)" },
    { sql: "SELECT count(*)::int AS rows FROM c", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity("BEGIN ATOMIC with several statements and a CASE ... END inside", C, [
  {
    sql: "CREATE FUNCTION f10(a int) RETURNS text LANGUAGE sql BEGIN ATOMIC INSERT INTO c VALUES (a); SELECT CASE WHEN a > 0 THEN 'pos' ELSE 'neg' END; END",
  },
  { sql: "SELECT f10(7) AS v", query: true },
  { sql: "SELECT count(*)::int AS n FROM c", query: true },
]);

parity(
  "CALL returns the INOUT parameters as one row",
  ["CREATE PROCEDURE p2(INOUT x int, INOUT y text) LANGUAGE plpgsql AS $$ BEGIN x := x * 2; y := y || '!'; END $$"],
  "CALL p2(3, 'a')",
);

parity(
  "CALL with an OUT parameter takes a placeholder argument for it",
  ["CREATE PROCEDURE p3(a int, OUT b int) LANGUAGE plpgsql AS $$ BEGIN b := a + 1; END $$"],
  "CALL p3(1, NULL)",
);

parity(
  "CALL with named arguments and defaults",
  ["CREATE PROCEDURE p4(a int DEFAULT 1, INOUT b int DEFAULT 5) LANGUAGE plpgsql AS $$ BEGIN b := a + b; END $$"],
  "CALL p4(b => 10)",
);

parity(
  "CALL with every argument defaulted",
  ["CREATE PROCEDURE p4(a int DEFAULT 1, INOUT b int DEFAULT 5) LANGUAGE plpgsql AS $$ BEGIN b := a + b; END $$"],
  "CALL p4()",
);

parity(
  "LANGUAGE sql procedures: the last statement's row fills the INOUT / OUT parameters",
  [
    "CREATE PROCEDURE q(a int, OUT b int) LANGUAGE sql AS $$ SELECT a * 2 $$",
    "CREATE PROCEDURE q2(INOUT a int, INOUT b text) LANGUAGE sql AS $$ SELECT a * 2, b || 'z' $$",
  ],
  "CALL q2(4, 'y')",
);

sequenceParity("LANGUAGE sql procedure with a BEGIN ATOMIC body writes", C, [
  {
    sql: "CREATE PROCEDURE p5(n int) LANGUAGE sql BEGIN ATOMIC INSERT INTO c VALUES (n); INSERT INTO c VALUES (n + 1); END",
  },
  { sql: "CALL p5(100)" },
  { sql: "SELECT a FROM c ORDER BY a", query: true },
]);

sequenceParity("CREATE OR REPLACE PROCEDURE, DROP PROCEDURE [IF EXISTS] and DROP ROUTINE", C, [
  { sql: "CREATE PROCEDURE p1(n int) LANGUAGE plpgsql AS $$ BEGIN INSERT INTO c VALUES (n); END $$" },
  { sql: "CREATE OR REPLACE PROCEDURE p1(n int) LANGUAGE sql AS $$ INSERT INTO c VALUES (n * 10) $$" },
  { sql: "CALL p1(2)" },
  { sql: "SELECT a FROM c ORDER BY a", query: true },
  { sql: "CREATE PROCEDURE p1(n int) LANGUAGE sql AS $$ SELECT 1 $$" },
  { sql: "DROP PROCEDURE p1(int)" },
  { sql: "DROP PROCEDURE p1" },
  { sql: "DROP PROCEDURE IF EXISTS p1" },
  { sql: "CREATE PROCEDURE p2(a int, OUT b int) LANGUAGE sql AS $$ SELECT a $$" },
  { sql: "DROP ROUTINE p2" },
  { sql: "SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('p1', 'p2')", query: true },
]);

sequenceParity(
  "a routine's kind cannot change, and DROP FUNCTION / DROP PROCEDURE name the right kind",
  [],
  [
    { sql: "CREATE FUNCTION f(n int) RETURNS int LANGUAGE sql AS $$ SELECT n $$" },
    { sql: "CREATE PROCEDURE p(n int) LANGUAGE sql AS $$ SELECT n $$" },
    { sql: "CREATE OR REPLACE PROCEDURE f(n int) LANGUAGE sql AS $$ SELECT n $$" },
    { sql: "CREATE OR REPLACE FUNCTION p(n int) RETURNS int LANGUAGE sql AS $$ SELECT n $$" },
    { sql: "DROP FUNCTION p(int)" },
    { sql: "DROP PROCEDURE f(int)" },
    { sql: "DROP PROCEDURE f" },
    { sql: "CREATE PROCEDURE p(n int) LANGUAGE sql AS $$ SELECT n $$" },
    { sql: "SELECT proname, prokind::text FROM pg_proc WHERE proname IN ('f', 'p') ORDER BY 1", query: true },
  ],
);

parity(
  "pg_proc: prokind 'p', pronargs without OUT parameters, void / record result",
  [
    "CREATE PROCEDURE p1(n int) LANGUAGE plpgsql AS $$ BEGIN END $$",
    "CREATE PROCEDURE p2(INOUT x int, INOUT y text) LANGUAGE plpgsql AS $$ BEGIN END $$",
    "CREATE PROCEDURE p3(a int, OUT b int) LANGUAGE plpgsql AS $$ BEGIN END $$",
  ],
  "SELECT proname, prokind::text, pronargs, prorettype::regtype::text AS rettype FROM pg_proc WHERE proname IN ('p1', 'p2', 'p3') ORDER BY 1",
);

parity(
  "pg_get_functiondef and pg_get_function_arguments of a procedure",
  ["CREATE PROCEDURE p3(a int, OUT b int) LANGUAGE plpgsql AS $$ BEGIN b := a; END $$"],
  "SELECT pg_get_functiondef('p3'::regproc) AS def, pg_get_function_arguments('p3'::regproc) AS args",
);

queryErrorParity(
  "calling a procedure with SELECT is 42809",
  ["CREATE PROCEDURE p1(n int) LANGUAGE plpgsql AS $$ BEGIN END $$"],
  "SELECT p1(1)",
);

errorParity(
  "CALL of a function is 42809",
  ["CREATE FUNCTION f(n int) RETURNS int LANGUAGE sql AS $$ SELECT n $$"],
  "CALL f(1)",
);

test("the SQLSTATEs of a procedure called as a function and a function called as a procedure", () => {
  const db = new Database();
  db.exec("CREATE PROCEDURE p1(n int) LANGUAGE plpgsql AS $$ BEGIN END $$");
  db.exec("CREATE FUNCTION f(n int) RETURNS int LANGUAGE sql AS $$ SELECT n $$");
  const sqlState = (sql: string) => {
    try {
      db.query(sql);
      return "ok";
    } catch (error) {
      return (error as { sqlState?: string }).sqlState;
    }
  };
  expect(sqlState("SELECT p1(1)")).toBe("42809");
  expect(sqlState("SELECT * FROM p1(1)")).toBe("42809");
  expect(sqlState("CALL f(1)")).toBe("42809");
  expect(sqlState("CALL pg_catalog.now()")).toBe("42809");
  expect(sqlState("CALL p1(1, 2)")).toBe("42883");
});

errorParity("CALL of a missing procedure is 42883", [], "CALL nosuch(1)", "undefined_function");

errorParity(
  "CALL without the OUT placeholder does not match",
  ["CREATE PROCEDURE p3(a int, OUT b int) LANGUAGE plpgsql AS $$ BEGIN b := a + 1; END $$"],
  "CALL p3(1)",
  "undefined_function",
);

errorParity(
  "CALL casts its arguments to the parameter types",
  ["CREATE PROCEDURE p1(n int) LANGUAGE plpgsql AS $$ BEGIN END $$"],
  "CALL p1('x')",
);

errorParity("CALL without an argument list is a syntax error", [], "CALL p8");

errorParity(
  "RETURN with a value in a procedure is refused when it is created",
  [],
  "CREATE PROCEDURE p6() LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$",
  "syntax",
);

errorParity(
  "a procedure has no RETURNS clause",
  [],
  "CREATE PROCEDURE p7() RETURNS int LANGUAGE plpgsql AS $$ BEGIN END $$",
);

errorParity(
  "a procedure with the same signature already exists",
  ["CREATE PROCEDURE p5() LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$"],
  "CREATE PROCEDURE p5() LANGUAGE plpgsql AS $$ BEGIN END $$",
);

sequenceParity("a bare RETURN ends a procedure; nested CALLs run", C, [
  {
    sql: "CREATE PROCEDURE r(n int) LANGUAGE plpgsql AS $$ BEGIN IF n <= 0 THEN RETURN; END IF; INSERT INTO c VALUES (n); CALL r(n - 1); END $$",
  },
  { sql: "CALL r(3)" },
  { sql: "SELECT a FROM c ORDER BY a", query: true },
]);

sequenceParity(
  "PL/pgSQL CALL writes OUT / INOUT results back to the variables passed",
  [],
  [
    {
      sql: "CREATE PROCEDURE io(INOUT x int, OUT y text) LANGUAGE plpgsql AS $$ BEGIN x := x + 1; y := 'y' || x; END $$",
    },
    {
      sql: "CREATE FUNCTION use_io() RETURNS text LANGUAGE plpgsql AS $$ DECLARE v int := 1; w text; BEGIN CALL io(v, w); CALL io(v, w); RETURN v || ' ' || w; END $$",
    },
    { sql: "SELECT use_io() AS v", query: true },
    { sql: "DO $$ BEGIN CALL io(1, NULL); END $$" },
  ],
);

// transaction control
const T = ["CREATE TABLE t (a int)"];

sequenceParity(
  "COMMIT / ROLLBACK in a procedure called outside a transaction block; an error keeps what was committed",
  T,
  [
    {
      sql: "CREATE PROCEDURE tc() LANGUAGE plpgsql AS $$ BEGIN INSERT INTO t VALUES (1); COMMIT; INSERT INTO t VALUES (2); ROLLBACK; INSERT INTO t VALUES (3); COMMIT; INSERT INTO t VALUES (4); RAISE EXCEPTION 'boom'; END $$",
    },
    { sql: "CALL tc()" },
    { sql: "SELECT a FROM t ORDER BY a", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "COMMIT AND CHAIN / ROLLBACK AND CHAIN, nested procedures and COMMIT inside a FOR loop",
  T,
  [
    {
      sql: "CREATE PROCEDURE inner_commit() LANGUAGE plpgsql AS $$ BEGIN INSERT INTO t VALUES (10); COMMIT; END $$",
    },
    {
      sql: "CREATE PROCEDURE outer_rollback() LANGUAGE plpgsql AS $$ BEGIN INSERT INTO t VALUES (30); CALL inner_commit(); INSERT INTO t VALUES (31); ROLLBACK; END $$",
    },
    { sql: "CALL outer_rollback()" },
    {
      sql: "CREATE PROCEDURE chain() LANGUAGE plpgsql AS $$ BEGIN INSERT INTO t VALUES (50); COMMIT AND CHAIN; INSERT INTO t VALUES (51); ROLLBACK AND CHAIN; END $$",
    },
    { sql: "CALL chain()" },
    {
      sql: "CREATE PROCEDURE loop_commit() LANGUAGE plpgsql AS $$ DECLARE r record; BEGIN FOR r IN SELECT a FROM t WHERE a < 40 ORDER BY a LOOP INSERT INTO t VALUES (r.a + 100); COMMIT; END LOOP; END $$",
    },
    { sql: "CALL loop_commit()" },
    { sql: "SELECT a FROM t ORDER BY a", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity("COMMIT in a procedure called inside a transaction block is 2D000, and the block rolls back", T, [
  { sql: "CREATE PROCEDURE tc2() LANGUAGE plpgsql AS $$ BEGIN INSERT INTO t VALUES (10); COMMIT; END $$" },
  { sql: "BEGIN" },
  { sql: "CALL tc2()" },
  { sql: "ROLLBACK" },
  { sql: "SELECT count(*)::int AS n FROM t", query: true },
]);

sequenceParity(
  "transaction control where PostgreSQL refuses it: functions, SET clauses, active subtransactions, SQL procedures",
  T,
  [
    { sql: "CREATE PROCEDURE tc2() LANGUAGE plpgsql AS $$ BEGIN COMMIT; END $$" },
    { sql: "CREATE FUNCTION fc() RETURNS int LANGUAGE plpgsql AS $$ BEGIN COMMIT; RETURN 1; END $$" },
    { sql: "SELECT fc()", query: true },
    { sql: "CREATE FUNCTION fc2() RETURNS int LANGUAGE plpgsql AS $$ BEGIN CALL tc2(); RETURN 1; END $$" },
    { sql: "SELECT fc2()", query: true },
    {
      sql: "CREATE PROCEDURE tc3() LANGUAGE plpgsql AS $$ BEGIN BEGIN INSERT INTO t VALUES (20); COMMIT; EXCEPTION WHEN division_by_zero THEN NULL; END; END $$",
    },
    { sql: "CALL tc3()" },
    { sql: "CREATE PROCEDURE tc6() LANGUAGE plpgsql SET search_path = public AS $$ BEGIN COMMIT; END $$" },
    { sql: "CALL tc6()" },
    { sql: "CREATE PROCEDURE ps() LANGUAGE sql AS $$ INSERT INTO t VALUES (60); COMMIT $$" },
    { sql: "CALL ps()" },
    { sql: "SELECT count(*)::int AS n FROM t", query: true },
  ],
);

sequenceParity(
  "COMMIT / ROLLBACK in a DO block outside a transaction block, and a DO that CALLs a committing procedure",
  T,
  [
    { sql: "DO $$ BEGIN INSERT INTO t VALUES (40); COMMIT; INSERT INTO t VALUES (41); ROLLBACK; END $$" },
    { sql: "CREATE PROCEDURE tc7() LANGUAGE plpgsql AS $$ BEGIN INSERT INTO t VALUES (70); COMMIT; END $$" },
    { sql: "DO $$ BEGIN CALL tc7(); INSERT INTO t VALUES (71); RAISE EXCEPTION 'stop'; END $$" },
    { sql: "BEGIN" },
    { sql: "DO $$ BEGIN COMMIT; END $$" },
    { sql: "ROLLBACK" },
    { sql: "SELECT a FROM t ORDER BY a", query: true },
  ],
  { compareFinalState: true },
);

test("a CALL inside Database.transaction() is atomic: COMMIT in the procedure is 2D000", () => {
  const db = new Database();
  db.exec("CREATE TABLE t (a int)");
  db.exec("CREATE PROCEDURE tc() LANGUAGE plpgsql AS $$ BEGIN INSERT INTO t VALUES (1); COMMIT; END $$");
  expect(() => db.transaction(() => db.exec("CALL tc()"))).toThrow(
    expect.objectContaining({ sqlState: "2D000" }) as unknown as Error,
  );
  expect(db.query("SELECT count(*)::int AS n FROM t")).toEqual([{ n: 0 }]);
  db.exec("CALL tc()");
  expect(db.query("SELECT count(*)::int AS n FROM t")).toEqual([{ n: 1 }]);
});

test("procedures survive a snapshot round trip", () => {
  const db = new Database();
  db.exec("CREATE TABLE t (a int)");
  db.exec("CREATE PROCEDURE p(INOUT x int, OUT y int) LANGUAGE plpgsql AS $$ BEGIN y := x * 2; x := x + 1; END $$");
  const copy = db.snapshot().open();
  expect(copy.query("CALL p(1, NULL)")).toEqual([{ x: 2, y: 2 }]);
  expect(copy.query("SELECT prokind::text AS k FROM pg_proc WHERE proname = 'p'")).toEqual([{ k: "p" }]);
});
