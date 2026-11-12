import { errorParity, parity, queryErrorParity, sequenceParity } from "../helpers.ts";

// #681: set-returning plpgsql functions.
parity(
  "RETURN NEXT <expr> in a SETOF function",
  ["CREATE FUNCTION a() RETURNS SETOF int LANGUAGE plpgsql AS $$ BEGIN RETURN NEXT 1; RETURN NEXT 2; RETURN; END $$"],
  "SELECT * FROM a()",
);

parity(
  "RETURN NEXT <variable> in a SETOF function",
  [
    "CREATE FUNCTION b() RETURNS SETOF int LANGUAGE plpgsql AS $$ DECLARE v int := 1; BEGIN RETURN NEXT v; v := 2; RETURN NEXT v; RETURN; END $$",
  ],
  "SELECT * FROM b()",
);

parity(
  "RETURN QUERY in a SETOF function",
  [
    "CREATE FUNCTION c() RETURNS SETOF int LANGUAGE plpgsql AS $$ BEGIN RETURN QUERY SELECT generate_series(1, 2); RETURN QUERY SELECT 5; END $$",
  ],
  "SELECT * FROM c()",
);

parity(
  "RETURN QUERY in a RETURNS TABLE function",
  [
    "CREATE FUNCTION d() RETURNS TABLE (n int, label text) LANGUAGE plpgsql AS $$ BEGIN RETURN QUERY SELECT 1, 'x'::text; END $$",
  ],
  "SELECT * FROM d()",
);

parity(
  "RETURN QUERY EXECUTE ... USING and RETURN NEXT of a record in a SETOF <table> function",
  [
    "CREATE TABLE t (a int, b text)",
    "INSERT INTO t VALUES (1, 'x'), (2, 'y'), (3, 'z')",
    "CREATE FUNCTION e(lim int) RETURNS SETOF t LANGUAGE plpgsql AS $$ DECLARE r t%ROWTYPE; BEGIN FOR r IN SELECT * FROM t ORDER BY a LOOP IF r.a < lim THEN RETURN NEXT r; END IF; END LOOP; RETURN QUERY EXECUTE 'SELECT * FROM t WHERE a >= $1 ORDER BY a' USING lim; END $$",
  ],
  "SELECT * FROM e(2)",
);

// #682: the statements ordinary functions are written in.
const C = ["CREATE TABLE c (a int)", "INSERT INTO c VALUES (4), (5)"];

parity(
  "SELECT ... INTO a record variable",
  [
    ...C,
    "CREATE FUNCTION f1() RETURNS int LANGUAGE plpgsql AS $$ DECLARE r record; BEGIN SELECT * INTO r FROM c ORDER BY a LIMIT 1; RETURN r.a; END $$",
  ],
  "SELECT f1() AS select_into_record",
);

parity(
  "SELECT ... INTO a %ROWTYPE variable",
  [
    ...C,
    "CREATE FUNCTION f2() RETURNS int LANGUAGE plpgsql AS $$ DECLARE r c%ROWTYPE; BEGIN SELECT * INTO r FROM c ORDER BY a LIMIT 1; RETURN r.a; END $$",
  ],
  "SELECT f2() AS rowtype",
);

parity(
  "SELECT INTO several scalars, %TYPE, and FOUND after a missing row",
  [
    ...C,
    "CREATE FUNCTION f2b() RETURNS text LANGUAGE plpgsql AS $$ DECLARE x c.a%TYPE; y int; BEGIN SELECT min(a), max(a) INTO x, y FROM c; SELECT a INTO y FROM c WHERE a = 99; RETURN x || ' ' || coalesce(y::text, 'null') || ' ' || FOUND::text; END $$",
  ],
  "SELECT f2b() AS v",
);

parity(
  "PERFORM with a FROM clause sets FOUND",
  [
    ...C,
    "CREATE FUNCTION f3(k int) RETURNS bool LANGUAGE plpgsql AS $$ BEGIN PERFORM 1 FROM c WHERE a = k; RETURN FOUND; END $$",
  ],
  "SELECT f3(99) AS missing, f3(4) AS present",
);

parity(
  "GET DIAGNOSTICS ROW_COUNT and FOUND after DML",
  [
    ...C,
    "CREATE FUNCTION f4() RETURNS text LANGUAGE plpgsql AS $$ DECLARE n int; m int; BEGIN UPDATE c SET a = a; GET DIAGNOSTICS n = ROW_COUNT; DELETE FROM c WHERE a = 99; GET CURRENT DIAGNOSTICS m := ROW_COUNT; RETURN n || ' ' || m || ' ' || FOUND::text; END $$",
  ],
  "SELECT f4() AS row_count",
);

parity(
  "integer FOR loops, REVERSE and BY",
  [
    "CREATE FUNCTION f5(n int) RETURNS text LANGUAGE plpgsql AS $$ DECLARE t int := 0; s text := ''; BEGIN FOR i IN 1..n LOOP t := t + i; END LOOP; FOR i IN REVERSE 10..1 BY 4 LOOP s := s || i || ','; END LOOP; RETURN t || ' ' || s; END $$",
  ],
  "SELECT f5(3) AS integer_for",
);

parity(
  "WHILE, LOOP, EXIT WHEN, CONTINUE WHEN and labels",
  [
    "CREATE FUNCTION f6(n int) RETURNS text LANGUAGE plpgsql AS $$ DECLARE t int := 0; k int := 0; BEGIN WHILE n > 0 LOOP t := t + n; n := n - 1; END LOOP; LOOP k := k + 1; CONTINUE WHEN k < 3; EXIT WHEN k >= 5; END LOOP; <<outer>> FOR i IN 1..3 LOOP FOR j IN 1..3 LOOP EXIT outer WHEN i * j = 4; t := t + 100; END LOOP; END LOOP outer; RETURN t || ' ' || k; END $$",
  ],
  "SELECT f6(3) AS while_loop",
);

parity(
  "EXECUTE ... INTO ... USING",
  [
    "CREATE FUNCTION f7() RETURNS int LANGUAGE plpgsql AS $$ DECLARE n int; BEGIN EXECUTE 'SELECT $1 + 1' INTO n USING 1; RETURN n; END $$",
  ],
  "SELECT f7() AS execute_into_using",
);

parity(
  "OUT parameters",
  ["CREATE FUNCTION f8(n int, OUT a int, OUT b int) LANGUAGE plpgsql AS $$ BEGIN a := n; b := n * 2; END $$"],
  "SELECT * FROM f8(2)",
);

parity(
  "one OUT parameter is the scalar result",
  ["CREATE FUNCTION f8b(n int, OUT a int) LANGUAGE plpgsql AS $$ BEGIN a := n + 1; END $$"],
  "SELECT f8b(2) AS v",
);

parity(
  "FOR over a query into a record variable sets FOUND",
  [
    ...C,
    "CREATE FUNCTION f10() RETURNS text LANGUAGE plpgsql AS $$ DECLARE r record; s int := 0; BEGIN FOR r IN SELECT a FROM c LOOP s := s + r.a; END LOOP; RETURN s || ' ' || FOUND::text; END $$",
  ],
  "SELECT f10() AS v",
);

sequenceParity(
  "INSERT ... RETURNING ... INTO",
  [
    "CREATE TABLE seq (id serial, v text)",
    "CREATE FUNCTION add(v text) RETURNS int LANGUAGE plpgsql AS $$ DECLARE new_id int; BEGIN INSERT INTO seq (v) VALUES (v) RETURNING id INTO new_id; RETURN new_id; END $$",
  ],
  [
    { sql: "SELECT add('a') AS id", query: true },
    { sql: "SELECT add('b') AS id", query: true },
  ],
);

queryErrorParity(
  "SELECT ... INTO STRICT with no row raises no_data_found",
  [
    ...C,
    "CREATE FUNCTION f11() RETURNS int LANGUAGE plpgsql AS $$ DECLARE x int; BEGIN SELECT a INTO STRICT x FROM c WHERE a = 99; RETURN x; END $$",
  ],
  "SELECT f11()",
);

queryErrorParity(
  "SELECT ... INTO STRICT with two rows raises too_many_rows",
  [
    ...C,
    "CREATE FUNCTION f12() RETURNS int LANGUAGE plpgsql AS $$ DECLARE x int; BEGIN SELECT a INTO STRICT x FROM c; RETURN x; END $$",
  ],
  "SELECT f12()",
);

queryErrorParity(
  "a SELECT without INTO has no destination",
  [...C, "CREATE FUNCTION f13() RETURNS int LANGUAGE plpgsql AS $$ BEGIN SELECT a FROM c; RETURN 1; END $$"],
  "SELECT f13()",
);

queryErrorParity(
  "reading a field of an unassigned record",
  ["CREATE FUNCTION f14() RETURNS int LANGUAGE plpgsql AS $$ DECLARE r record; BEGIN RETURN r.a; END $$"],
  "SELECT f14()",
);

errorParity(
  "a syntax error in a plpgsql body is reported by CREATE FUNCTION",
  [],
  "CREATE FUNCTION f15() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1 END $$",
);

queryErrorParity(
  "a function that reaches its end without RETURN",
  ["CREATE FUNCTION f16() RETURNS int LANGUAGE plpgsql AS $$ BEGIN NULL; END $$"],
  "SELECT f16()",
);

queryErrorParity(
  "a CASE statement with no matching branch and no ELSE raises case_not_found",
  [
    "CREATE FUNCTION f17(x int) RETURNS int LANGUAGE plpgsql AS $$ BEGIN CASE x WHEN 1 THEN RETURN 1; END CASE; RETURN 0; END $$",
  ],
  "SELECT f17(2)",
);

queryErrorParity(
  "ASSERT raises assert_failure with its message",
  [
    "CREATE FUNCTION f18(x int) RETURNS int LANGUAGE plpgsql AS $$ BEGIN ASSERT x > 0, 'x must be positive'; RETURN x; END $$",
  ],
  "SELECT f18(-1)",
);

parity(
  "GET STACKED DIAGNOSTICS in a handler, FOREACH and a nested DECLARE block",
  [
    `CREATE FUNCTION f19() RETURNS text LANGUAGE plpgsql AS $$
DECLARE s text := ''; st text; msg text; x int := 1;
BEGIN
  FOREACH x IN ARRAY ARRAY[3, 4] LOOP s := s || x; END LOOP;
  DECLARE x text := 'inner'; BEGIN s := s || x; END;
  BEGIN
    PERFORM 1 / 0;
  EXCEPTION WHEN division_by_zero THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  END;
  RETURN s || ' ' || x || ' ' || st || ' ' || msg;
END $$`,
  ],
  "SELECT f19() AS v",
);

parity(
  "EXIT from a labelled block and CONTINUE in a FOR loop over a query",
  [
    ...C,
    `CREATE FUNCTION f20() RETURNS int LANGUAGE plpgsql AS $$
DECLARE r record; t int := 0;
BEGIN
  <<blk>> BEGIN t := 1; EXIT blk; t := 99; END;
  FOR r IN SELECT a FROM c ORDER BY a LOOP CONTINUE WHEN r.a = 4; t := t + r.a; END LOOP;
  RETURN t;
END $$`,
  ],
  "SELECT f20() AS v",
);
