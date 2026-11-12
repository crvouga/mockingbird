import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { errorParity, parity, sequenceParity } from "../helpers.ts";

// #682: PL/pgSQL cursors, checked against PostgreSQL (PGlite). Portal names PostgreSQL generates
// ("<unnamed portal N>") count every portal of the session, protocol ones included, so the cases
// never print them.

const T = ["CREATE TABLE t (a int, b text)", "INSERT INTO t VALUES (1, 'x'), (2, 'y'), (3, 'z'), (4, 'w')"];

parity(
  "a bound cursor: OPEN, FETCH into a record until NOT FOUND, CLOSE",
  [
    ...T,
    "CREATE FUNCTION c1() RETURNS text LANGUAGE plpgsql AS $$ DECLARE c CURSOR FOR SELECT a, b FROM t ORDER BY a; r record; s text := ''; BEGIN OPEN c; LOOP FETCH c INTO r; EXIT WHEN NOT FOUND; s := s || r.a || r.b; END LOOP; CLOSE c; RETURN s; END $$",
  ],
  "SELECT c1() AS v",
);

parity(
  "FOR over a bound cursor with positional and named arguments",
  [
    ...T,
    "CREATE FUNCTION c2(lim int) RETURNS text LANGUAGE plpgsql AS $$ DECLARE c CURSOR (m int) FOR SELECT a FROM t WHERE a <= m ORDER BY a; s text := ''; BEGIN FOR r IN c(lim) LOOP s := s || r.a; END LOOP; FOR r IN c(m := 1) LOOP s := s || '/' || r.a; END LOOP; RETURN s; END $$",
  ],
  "SELECT c2(3) AS v",
);

parity(
  "an unbound refcursor: OPEN FOR, FETCH into scalars, MOVE, FETCH past the end sets the targets NULL",
  [
    ...T,
    "CREATE FUNCTION c3() RETURNS text LANGUAGE plpgsql AS $$ DECLARE c refcursor; x int; y text; s text := ''; BEGIN OPEN c FOR SELECT a, b FROM t ORDER BY a; FETCH c INTO x, y; s := s || x || y; MOVE c; FETCH c INTO x; s := s || x; MOVE FORWARD 0 FROM c; FETCH NEXT FROM c INTO x; s := s || x; FETCH c INTO x; s := s || coalesce(x::text, 'null') || FOUND::text; CLOSE c; RETURN s; END $$",
  ],
  "SELECT c3() AS v",
);

parity(
  "SCROLL cursor directions and MOVE row counts",
  [
    ...T,
    "CREATE FUNCTION c4() RETURNS text LANGUAGE plpgsql AS $$ DECLARE c SCROLL CURSOR FOR SELECT a FROM t ORDER BY a; x int; s text := ''; BEGIN OPEN c; FETCH LAST FROM c INTO x; s := s || x; FETCH PRIOR FROM c INTO x; s := s || x; FETCH FIRST FROM c INTO x; s := s || x; FETCH ABSOLUTE 3 FROM c INTO x; s := s || x; FETCH RELATIVE -1 FROM c INTO x; s := s || x; FETCH ABSOLUTE -1 FROM c INTO x; s := s || x; MOVE ABSOLUTE 0 FROM c; FETCH c INTO x; s := s || x; MOVE LAST FROM c; FETCH c INTO x; s := s || FOUND::text; MOVE BACKWARD 2 FROM c; GET DIAGNOSTICS x = ROW_COUNT; s := s || 'rc' || x; FETCH c INTO x; s := s || x; MOVE FORWARD ALL FROM c; GET DIAGNOSTICS x = ROW_COUNT; s := s || 'rc' || x || FOUND::text; RETURN s; END $$",
  ],
  "SELECT c4() AS v",
);

parity(
  "a cursor without SCROLL can still step back; FETCH PRIOR before the first row finds nothing",
  [
    ...T,
    "CREATE FUNCTION c12() RETURNS text LANGUAGE plpgsql AS $$ DECLARE c CURSOR FOR SELECT a FROM t ORDER BY a; x int; BEGIN OPEN c; FETCH c INTO x; FETCH PRIOR FROM c INTO x; RETURN coalesce(x::text, 'null'); END $$",
  ],
  "SELECT c12() AS v",
);

parity(
  "OPEN FOR EXECUTE ... USING, re-OPEN after CLOSE, and the portal name in the variable",
  [
    ...T,
    "CREATE FUNCTION c11() RETURNS text LANGUAGE plpgsql AS $$ DECLARE c refcursor; x int; s text := ''; BEGIN OPEN c FOR EXECUTE 'SELECT a FROM t WHERE a > $1 ORDER BY a' USING 2; FETCH c INTO x; s := s || x; CLOSE c; OPEN c FOR SELECT 9; FETCH c INTO x; RETURN s || x || (c IS NOT NULL)::text; END $$",
  ],
  "SELECT c11() AS v",
);

parity(
  "a refcursor variable that names its portal",
  [
    ...T,
    "CREATE FUNCTION c6() RETURNS text LANGUAGE plpgsql AS $$ DECLARE c refcursor := 'mycur'; x int; BEGIN OPEN c FOR SELECT a FROM t ORDER BY a DESC; FETCH c INTO x; CLOSE c; RETURN c || ' ' || x; END $$",
  ],
  "SELECT c6() AS v, c6() AS again",
);

parity(
  "a cursor sees the rows as of OPEN",
  [
    ...T,
    "CREATE FUNCTION c19() RETURNS text LANGUAGE plpgsql AS $$ DECLARE c CURSOR FOR SELECT a FROM t ORDER BY a; x int; BEGIN OPEN c; FETCH c INTO x; DELETE FROM t WHERE a = 2; FETCH c INTO x; CLOSE c; RETURN x::text; END $$",
  ],
  "SELECT c19() AS v",
);

sequenceParity("cursor errors at run time", T, [
  {
    sql: "CREATE FUNCTION c7() RETURNS text LANGUAGE plpgsql AS $$ DECLARE c refcursor := 'dup'; BEGIN OPEN c FOR SELECT 1; OPEN c FOR SELECT 2; RETURN 'x'; END $$",
  },
  { sql: "SELECT c7()", query: true },
  {
    sql: "CREATE FUNCTION c8() RETURNS text LANGUAGE plpgsql AS $$ DECLARE c refcursor; x int; BEGIN FETCH c INTO x; RETURN 'x'; END $$",
  },
  { sql: "SELECT c8()", query: true },
  {
    sql: "CREATE FUNCTION c9() RETURNS text LANGUAGE plpgsql AS $$ DECLARE c CURSOR FOR SELECT 1; x int; BEGIN FETCH c INTO x; RETURN 'x'; END $$",
  },
  { sql: "SELECT c9()", query: true },
  {
    sql: "CREATE FUNCTION c10() RETURNS text LANGUAGE plpgsql AS $$ DECLARE c CURSOR FOR SELECT 1; BEGIN CLOSE c; RETURN 'x'; END $$",
  },
  { sql: "SELECT c10()", query: true },
  {
    sql: "CREATE FUNCTION c13() RETURNS text LANGUAGE plpgsql AS $$ DECLARE c NO SCROLL CURSOR FOR SELECT a FROM t ORDER BY a; x int; BEGIN OPEN c; FETCH c INTO x; FETCH PRIOR FROM c INTO x; RETURN x::text; END $$",
  },
  { sql: "SELECT c13()", query: true },
  {
    sql: "CREATE FUNCTION c20() RETURNS text LANGUAGE plpgsql AS $$ DECLARE c refcursor := 'busy'; d CURSOR FOR SELECT 1; BEGIN OPEN c FOR SELECT 1; CLOSE c; CLOSE c; RETURN 'x'; END $$",
  },
  { sql: "SELECT c20()", query: true },
]);

for (const [label, body] of [
  ["OPEN of a cursor with arguments without them", "DECLARE c CURSOR (k int) FOR SELECT k; BEGIN OPEN c; END"],
  ["OPEN of a bound cursor FOR a query", "DECLARE c CURSOR FOR SELECT 1; BEGIN OPEN c FOR SELECT 1; END"],
  ["FOR over an unbound cursor", "DECLARE c refcursor; BEGIN FOR r IN c LOOP END LOOP; END"],
  ["FETCH of several rows", "DECLARE c CURSOR FOR SELECT 1; x int; BEGIN OPEN c; FETCH FORWARD 2 FROM c INTO x; END"],
] as const) {
  errorParity(
    `the body is refused when it is created: ${label}`,
    [],
    `CREATE FUNCTION bad() RETURNS void LANGUAGE plpgsql AS $$ ${body} $$`,
  );
}

sequenceParity(
  "cursors in DO blocks and procedures; a portal opened outside a transaction block closes with its statement",
  ["CREATE TABLE out (v text)", ...T],
  [
    {
      sql: "DO $$ DECLARE c refcursor := 'kept'; r record; BEGIN OPEN c FOR SELECT a FROM t ORDER BY a; FETCH c INTO r; INSERT INTO out VALUES ('do ' || r.a); END $$",
    },
    { sql: "DO $$ DECLARE c refcursor := 'kept'; BEGIN OPEN c FOR SELECT 1; CLOSE c; END $$" },
    {
      sql: "CREATE PROCEDURE pc() LANGUAGE plpgsql AS $$ DECLARE c CURSOR FOR SELECT a FROM t ORDER BY a; BEGIN FOR r IN c LOOP INSERT INTO out VALUES ('proc ' || r.a); END LOOP; END $$",
    },
    { sql: "CALL pc()" },
    { sql: "SELECT v FROM out ORDER BY v", query: true },
  ],
);

sequenceParity("COMMIT in a procedure closes the cursors it opened", T, [
  {
    sql: "CREATE PROCEDURE pcc() LANGUAGE plpgsql AS $$ DECLARE c refcursor := 'gone'; x int; BEGIN OPEN c FOR SELECT a FROM t; COMMIT; FETCH c INTO x; END $$",
  },
  { sql: "CALL pcc()" },
]);

sequenceParity("inside a transaction block a portal outlives the statement that opened it", T, [
  {
    sql: "CREATE FUNCTION open_it() RETURNS text LANGUAGE plpgsql AS $$ DECLARE c refcursor := 'shared'; BEGIN OPEN c FOR SELECT a FROM t ORDER BY a; RETURN 'opened'; END $$",
  },
  {
    sql: "CREATE FUNCTION next_of() RETURNS int LANGUAGE plpgsql AS $$ DECLARE c refcursor := 'shared'; x int; BEGIN FETCH c INTO x; RETURN x; END $$",
  },
  { sql: "BEGIN" },
  { sql: "SELECT open_it() AS v", query: true },
  { sql: "SELECT next_of() AS v", query: true },
  { sql: "SELECT next_of() AS v", query: true },
  { sql: "COMMIT" },
  { sql: "SELECT next_of() AS v", query: true },
]);

test("UPDATE ... WHERE CURRENT OF a PL/pgSQL cursor fails loud", () => {
  const db = new Database();
  for (const sql of T) db.exec(sql);
  db.exec(
    "CREATE FUNCTION cur_upd() RETURNS void LANGUAGE plpgsql AS $$ DECLARE c CURSOR FOR SELECT a FROM t FOR UPDATE; BEGIN FOR r IN c LOOP UPDATE t SET b = b || '!' WHERE CURRENT OF c; END LOOP; END $$",
  );
  expect(() => db.query("SELECT cur_upd()")).toThrow(
    expect.objectContaining({ sqlState: "0A000" }) as unknown as Error,
  );
});

test("the refcursor SQL type fails loud (cursor variables live inside PL/pgSQL)", () => {
  const db = new Database();
  expect(() => db.exec("CREATE FUNCTION rc() RETURNS refcursor LANGUAGE sql AS $$ SELECT 'x' $$")).toThrow(
    expect.objectContaining({ sqlState: "0A000" }) as unknown as Error,
  );
});
