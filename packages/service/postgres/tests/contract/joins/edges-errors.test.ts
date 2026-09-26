import { parity, queryErrorParity } from "../helpers.ts";

// null handling at join keys
parity(
  "null keys never match in inner join",
  [
    "CREATE TABLE a (k int, v text)",
    "CREATE TABLE b (k int, w text)",
    "INSERT INTO a VALUES (NULL, 'an'), (1, 'a1')",
    "INSERT INTO b VALUES (NULL, 'bn'), (1, 'b1')",
  ],
  "SELECT a.v, b.w FROM a JOIN b ON a.k = b.k ORDER BY a.v",
);
parity(
  "left join null key produces null right side",
  [
    "CREATE TABLE a (k int, v text)",
    "CREATE TABLE b (k int, w text)",
    "INSERT INTO a VALUES (NULL, 'an'), (1, 'a1')",
    "INSERT INTO b VALUES (1, 'b1')",
  ],
  "SELECT a.v, b.w FROM a LEFT JOIN b ON a.k = b.k ORDER BY a.v",
);
parity(
  "is not distinct from join matches nulls",
  [
    "CREATE TABLE a (k int, v text)",
    "CREATE TABLE b (k int, w text)",
    "INSERT INTO a VALUES (NULL, 'an'), (1, 'a1')",
    "INSERT INTO b VALUES (NULL, 'bn'), (1, 'b1')",
  ],
  "SELECT a.v, b.w FROM a JOIN b ON a.k IS NOT DISTINCT FROM b.k ORDER BY a.v",
);
parity(
  "duplicate rows multiply in join",
  [
    "CREATE TABLE a (k int)",
    "CREATE TABLE b (k int)",
    "INSERT INTO a VALUES (1), (1)",
    "INSERT INTO b VALUES (1), (1), (1)",
  ],
  "SELECT a.k, b.k AS bk FROM a JOIN b ON a.k = b.k ORDER BY a.k",
);
parity(
  "full join no matches at all",
  [
    "CREATE TABLE a (k int)",
    "CREATE TABLE b (k int)",
    "INSERT INTO a VALUES (1), (2)",
    "INSERT INTO b VALUES (3), (4)",
  ],
  "SELECT a.k AS ak, b.k AS bk FROM a FULL JOIN b ON a.k = b.k ORDER BY ak NULLS LAST, bk NULLS LAST",
);
parity(
  "cross join with empty table yields nothing",
  ["CREATE TABLE a (x int)", "CREATE TABLE b (y int)", "INSERT INTO a VALUES (1)"],
  "SELECT * FROM a CROSS JOIN b",
);
parity(
  "same column names from both tables",
  [
    "CREATE TABLE a (id int, v text)",
    "CREATE TABLE b (id int, v text)",
    "INSERT INTO a VALUES (1, 'av')",
    "INSERT INTO b VALUES (1, 'bv')",
  ],
  "SELECT a.v AS av, b.v AS bv FROM a JOIN b ON a.id = b.id",
);
parity(
  "join with where on outer null check",
  [
    "CREATE TABLE a (k int)",
    "CREATE TABLE b (k int)",
    "INSERT INTO a VALUES (1), (2), (3)",
    "INSERT INTO b VALUES (2)",
  ],
  "SELECT a.k FROM a LEFT JOIN b ON a.k = b.k WHERE b.k IS NULL ORDER BY a.k",
);

// errors
queryErrorParity(
  "ambiguous column in join",
  [
    "CREATE TABLE a (id int, v text)",
    "CREATE TABLE b (id int, w text)",
    "INSERT INTO a VALUES (1, 'x')",
    "INSERT INTO b VALUES (1, 'y')",
  ],
  "SELECT id FROM a JOIN b ON a.id = b.id",
  "ambiguous",
);
queryErrorParity(
  "using column missing from one side",
  ["CREATE TABLE a (id int)", "CREATE TABLE b (other int)", "INSERT INTO a VALUES (1)", "INSERT INTO b VALUES (1)"],
  "SELECT * FROM a JOIN b USING (id)",
  "undefined_column",
);
