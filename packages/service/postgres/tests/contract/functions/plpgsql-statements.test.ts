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

// #682: ALIAS FOR, assignment to array elements and slices, FOREACH ... SLICE.
parity(
  "ALIAS FOR $n and for a named parameter share the parameter's variable",
  [
    "CREATE FUNCTION a1(int, text) RETURNS text LANGUAGE plpgsql AS $$ DECLARE n ALIAS FOR $1; s ALIAS FOR $2; BEGIN n := n + 1; RETURN s || n || $1; END $$",
    "CREATE FUNCTION a2(v int) RETURNS int LANGUAGE plpgsql AS $$ DECLARE w ALIAS FOR v; BEGIN w := w * 10; RETURN v; END $$",
    "CREATE FUNCTION a4() RETURNS int LANGUAGE plpgsql AS $$ DECLARE x int := 5; BEGIN DECLARE y ALIAS FOR x; BEGIN y := 6; END; RETURN x; END $$",
  ],
  "SELECT a1(1, 'x') AS a1, a2(2) AS a2, a4() AS a4",
);

sequenceParity(
  "ALIAS FOR NEW in a trigger function",
  ["CREATE TABLE tt (a int)"],
  [
    {
      sql: "CREATE FUNCTION trg() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE nr ALIAS FOR new; BEGIN nr.a := nr.a * 2; RETURN nr; END $$",
    },
    { sql: "CREATE TRIGGER t1 BEFORE INSERT ON tt FOR EACH ROW EXECUTE FUNCTION trg()" },
    { sql: "INSERT INTO tt VALUES (21)" },
    { sql: "SELECT a FROM tt", query: true },
  ],
);

errorParity(
  "ALIAS FOR an unknown variable is refused when the function is created",
  [],
  "CREATE FUNCTION a3() RETURNS int LANGUAGE plpgsql AS $$ DECLARE w ALIAS FOR nosuch; BEGIN RETURN 1; END $$",
);

errorParity(
  "ALIAS FOR a parameter past the last one is refused when the function is created",
  [],
  "CREATE FUNCTION a5(int) RETURNS int LANGUAGE plpgsql AS $$ DECLARE w ALIAS FOR $3; BEGIN RETURN 1; END $$",
);

parity(
  "assignment to array elements extends one-dimensional arrays, also below the lower bound",
  [
    "CREATE FUNCTION e1() RETURNS text LANGUAGE plpgsql AS $$ DECLARE a int[] := ARRAY[1,2,3]; BEGIN a[2] := 20; a[5] := 50; RETURN a::text; END $$",
    "CREATE FUNCTION e2() RETURNS text LANGUAGE plpgsql AS $$ DECLARE a int[]; BEGIN a[3] := 1; RETURN a::text || array_lower(a, 1); END $$",
    "CREATE FUNCTION e4() RETURNS text LANGUAGE plpgsql AS $$ DECLARE a int[] := ARRAY[1,2,3]; BEGIN a[0] := 0; a[-2] := -2; RETURN a::text; END $$",
    "CREATE FUNCTION e6() RETURNS text LANGUAGE plpgsql AS $$ DECLARE a text[] := '{}'; BEGIN FOR i IN 1..3 LOOP a[i] := i::text || 'x'; END LOOP; RETURN a::text; END $$",
  ],
  "SELECT e1() AS e1, e2() AS e2, e4() AS e4, e6() AS e6",
);

parity(
  "assignment to an element of a multi-dimensional array, a slice, and an array field of a record",
  [
    "CREATE TABLE ar (id int, v int[])",
    "CREATE FUNCTION e3() RETURNS text LANGUAGE plpgsql AS $$ DECLARE a int[] := '{{1,2},{3,4}}'; BEGIN a[2][1] := 30; RETURN a::text; END $$",
    "CREATE FUNCTION e5() RETURNS text LANGUAGE plpgsql AS $$ DECLARE a int[] := ARRAY[1,2,3,4]; BEGIN a[2:3] := ARRAY[20,30]; RETURN a::text; END $$",
    "CREATE FUNCTION e8() RETURNS text LANGUAGE plpgsql AS $$ DECLARE r ar%ROWTYPE; BEGIN r.v := ARRAY[1]; r.v[3] := 3; RETURN r.v::text; END $$",
  ],
  "SELECT e3() AS e3, e5() AS e5, e8() AS e8",
);

for (const [label, body] of [
  ["a NULL subscript", "DECLARE a int[] := ARRAY[1]; BEGIN a[NULL] := 1; RETURN a::text; END"],
  ["a value of the wrong type", "DECLARE a int[] := ARRAY[1,2]; BEGIN a[2] := 'abc'; RETURN a::text; END"],
  ["a subscript on a scalar", "DECLARE a int; BEGIN a[1] := 1; RETURN a::text; END"],
  [
    "an element outside a multi-dimensional array",
    "DECLARE a int[] := '{{1,2},{3,4}}'; BEGIN a[3][1] := 30; RETURN a::text; END",
  ],
  ["a slice longer than its source", "DECLARE a int[] := ARRAY[1,2,3]; BEGIN a[1:2] := ARRAY[9]; RETURN a::text; END"],
] as const) {
  queryErrorParity(
    `array element assignment errors: ${label}`,
    [`CREATE FUNCTION bad() RETURNS text LANGUAGE plpgsql AS $$ ${body} $$`],
    "SELECT bad()",
  );
}

parity(
  "FOREACH ... SLICE over a 2-D and 3-D array, a whole 1-D array, and kept lower bounds",
  [
    "CREATE FUNCTION s1() RETURNS text LANGUAGE plpgsql AS $$ DECLARE x int[]; s text := ''; BEGIN FOREACH x SLICE 1 IN ARRAY ARRAY[[1,2],[3,4],[5,6]] LOOP s := s || x::text || ';'; END LOOP; RETURN s; END $$",
    "CREATE FUNCTION s2() RETURNS text LANGUAGE plpgsql AS $$ DECLARE x int[]; s text := ''; BEGIN FOREACH x SLICE 1 IN ARRAY ARRAY[1,2,3] LOOP s := s || x::text || ';'; END LOOP; RETURN s; END $$",
    "CREATE FUNCTION s3() RETURNS text LANGUAGE plpgsql AS $$ DECLARE x int[]; s text := ''; BEGIN FOREACH x SLICE 2 IN ARRAY '{{{1,2},{3,4}},{{5,6},{7,8}}}'::int[] LOOP s := s || x::text || ';'; END LOOP; RETURN s; END $$",
    "CREATE FUNCTION s7() RETURNS text LANGUAGE plpgsql AS $$ DECLARE x int[]; s text := ''; BEGIN FOREACH x SLICE 1 IN ARRAY '[2:3][0:1]={{1,2},{3,4}}'::int[] LOOP s := s || x::text || array_lower(x, 1) || ';'; END LOOP; RETURN s; END $$",
    "CREATE FUNCTION s9() RETURNS text LANGUAGE plpgsql AS $$ DECLARE x int; s text := ''; BEGIN FOREACH x IN ARRAY ARRAY[[1,2],[3,4]] LOOP s := s || x::text || ';'; END LOOP; RETURN s; END $$",
  ],
  "SELECT s1() AS s1, s2() AS s2, s3() AS s3, s7() AS s7, s9() AS s9",
);

for (const [label, body] of [
  [
    "a slice deeper than the array",
    "x int[]; BEGIN FOREACH x SLICE 3 IN ARRAY ARRAY[[1,2],[3,4]] LOOP END LOOP; RETURN 'x'; END",
  ],
  [
    "a scalar slice variable",
    "x int; BEGIN FOREACH x SLICE 1 IN ARRAY ARRAY[[1,2],[3,4]] LOOP END LOOP; RETURN 'x'; END",
  ],
  [
    "an array variable without SLICE",
    "x int[]; BEGIN FOREACH x SLICE 0 IN ARRAY ARRAY[[1,2],[3,4]] LOOP END LOOP; RETURN 'x'; END",
  ],
  ["SLICE of an empty array", "x int[]; BEGIN FOREACH x SLICE 1 IN ARRAY '{}'::int[] LOOP END LOOP; RETURN 'x'; END"],
] as const) {
  queryErrorParity(
    `FOREACH ... SLICE errors: ${label}`,
    [`CREATE FUNCTION bad() RETURNS text LANGUAGE plpgsql AS $$ DECLARE ${body} $$`],
    "SELECT bad()",
  );
}

errorParity(
  "the SLICE dimension must be a constant",
  [],
  "CREATE FUNCTION s10(n int) RETURNS text LANGUAGE plpgsql AS $$ DECLARE x int[]; BEGIN FOREACH x SLICE n IN ARRAY ARRAY[1] LOOP END LOOP; RETURN ''; END $$",
);
