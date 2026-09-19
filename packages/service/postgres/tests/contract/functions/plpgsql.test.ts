import { parity } from "../helpers.ts";

parity(
  "plpgsql scalar DECLARE and RETURN",
  [
    `CREATE FUNCTION add_one(a int) RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  x int := 0;
BEGIN
  x := a + 1;
  RETURN x;
END;
$$`,
  ],
  "SELECT add_one(41) AS v",
);

parity(
  "plpgsql EXCEPTION WHEN others catches a bad cast",
  [
    `CREATE FUNCTION safe_int(p text) RETURNS int LANGUAGE plpgsql AS $$
BEGIN
  RETURN p::int;
EXCEPTION
  WHEN others THEN
    RETURN -1;
END;
$$`,
  ],
  "SELECT safe_int('12'::text) AS ok, safe_int('nope'::text) AS bad",
);

parity(
  "plpgsql RETURNS TABLE with RETURN NEXT",
  [
    `CREATE FUNCTION pair_rows() RETURNS TABLE(a int, b text) LANGUAGE plpgsql AS $$
BEGIN
  a := 1;
  b := 'x';
  RETURN NEXT;
  a := 2;
  b := 'y';
  RETURN NEXT;
END;
$$`,
  ],
  "SELECT * FROM pair_rows() ORDER BY a",
);

parity(
  "plpgsql FOR IN SELECT loops a set",
  [
    "CREATE TABLE src (id int)",
    "INSERT INTO src VALUES (1), (2), (3)",
    `CREATE FUNCTION ids_plus() RETURNS TABLE(n int) LANGUAGE plpgsql AS $$
DECLARE
  x int;
BEGIN
  FOR x IN SELECT id FROM src ORDER BY id LOOP
    n := x + 10;
    RETURN NEXT;
  END LOOP;
END;
$$`,
  ],
  "SELECT * FROM ids_plus() ORDER BY n",
);

parity(
  "plpgsql CASE statement",
  [
    `CREATE FUNCTION kind(n int) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  CASE n
    WHEN 1 THEN RETURN 'one';
    WHEN 2 THEN RETURN 'two';
    ELSE RETURN 'other';
  END CASE;
END;
$$`,
  ],
  "SELECT kind(1) AS a, kind(2) AS b, kind(9) AS c",
);
