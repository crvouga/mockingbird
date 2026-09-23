import { errorParity, queryErrorParity } from "../helpers.ts";

queryErrorParity("integer division by zero fails with 22012", [], "SELECT 1/0", "division_by_zero");

queryErrorParity("modulo by zero fails with 22012", [], "SELECT 5 % 0", "division_by_zero");

queryErrorParity("numeric division by zero fails with 22012", [], "SELECT 1.0/0", "division_by_zero");

queryErrorParity(
  "division by a zero-valued column fails with 22012",
  ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (0)"],
  "SELECT 10 / n FROM t",
  "division_by_zero",
);

queryErrorParity(
  "non-numeric text cast to int fails with 22P02",
  [],
  "SELECT 'abc'::int",
  "invalid_text_representation",
);

queryErrorParity(
  "non-boolean text cast to boolean fails with 22P02",
  [],
  "SELECT 'notabool'::boolean",
  "invalid_text_representation",
);

queryErrorParity("malformed uuid cast fails with 22P02", [], "SELECT 'xyz'::uuid", "invalid_text_representation");

queryErrorParity("malformed jsonb literal fails with 22P02", [], "SELECT '{bad'::jsonb", "invalid_text_representation");

queryErrorParity("integer overflow fails with 22003", [], "SELECT 2147483647::int + 1", "numeric_out_of_range");

queryErrorParity("smallint overflow on cast fails with 22003", [], "SELECT 100000::smallint", "numeric_out_of_range");

errorParity(
  "varchar length overflow on INSERT fails with 22001",
  ["CREATE TABLE t (v varchar(3))"],
  "INSERT INTO t VALUES ('abcd')",
  "data_exception",
);

errorParity(
  "char length overflow on INSERT fails with 22001",
  ["CREATE TABLE t (v char(2))"],
  "INSERT INTO t VALUES ('abc')",
  "data_exception",
);
