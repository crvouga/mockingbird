import { parity, queryErrorParity } from "../helpers.ts";

parity("int array parameter from array literal text", [], "SELECT $1::int[] AS v", ["{1,2,3}"]);

parity("text array parameter", [], "SELECT $1::text[] AS v", ["{a,b,c}"]);

parity("empty array parameter", [], "SELECT $1::int[] AS v", ["{}"]);

parity("array parameter element access", [], "SELECT ($1::int[])[2] AS v", ["{10,20,30}"]);

parity("array parameter length", [], "SELECT array_length($1::int[], 1) AS v", ["{1,2,3,4}"]);

parity("unnest of an array parameter", [], "SELECT u FROM unnest($1::int[]) AS u ORDER BY u", ["{3,1,2}"]);

parity(
  "ANY over an array parameter",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2), (3), (4)"],
  "SELECT id FROM t WHERE id = ANY($1::int[]) ORDER BY id",
  ["{2,4}"],
);

parity(
  "ALL over an array parameter",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (5), (6)"],
  "SELECT id FROM t WHERE id > ALL($1::int[]) ORDER BY id",
  ["{1,2,3,5}"],
);

parity("array containment against a parameter", [], "SELECT $1::int[] @> ARRAY[2] AS v", ["{1,2,3}"]);

queryErrorParity("referencing $1 with no parameters fails", [], "SELECT $1::int");

queryErrorParity("referencing $2 with no parameters fails", [], "SELECT $2::int");

queryErrorParity("mixed defined and undefined parameter positions fail", [], "SELECT $1::int + $3::int");
