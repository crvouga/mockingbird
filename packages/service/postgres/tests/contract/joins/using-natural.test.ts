import { parity } from "../helpers.ts";

const shared = [
  "CREATE TABLE a (id int, av text)",
  "CREATE TABLE b (id int, bv text)",
  "INSERT INTO a VALUES (1, 'a1'), (2, 'a2'), (3, 'a3')",
  "INSERT INTO b VALUES (2, 'b2'), (3, 'b3'), (4, 'b4')",
];

parity("join using single column", shared, "SELECT id, av, bv FROM a JOIN b USING (id) ORDER BY id");
parity("join using star merges key column", shared, "SELECT * FROM a JOIN b USING (id) ORDER BY id");
parity("left join using", shared, "SELECT id, av, bv FROM a LEFT JOIN b USING (id) ORDER BY id");
parity("full join using coalesces key", shared, "SELECT id, av, bv FROM a FULL JOIN b USING (id) ORDER BY id");
parity("join using unqualified key reference", shared, "SELECT id FROM a JOIN b USING (id) WHERE id > 2 ORDER BY id");
parity(
  "join using multiple columns",
  [
    "CREATE TABLE a (x int, y int, av text)",
    "CREATE TABLE b (x int, y int, bv text)",
    "INSERT INTO a VALUES (1, 1, 'a11'), (1, 2, 'a12'), (2, 1, 'a21')",
    "INSERT INTO b VALUES (1, 1, 'b11'), (2, 1, 'b21'), (2, 2, 'b22')",
  ],
  "SELECT x, y, av, bv FROM a JOIN b USING (x, y) ORDER BY x, y",
);
parity(
  "natural join",
  [
    "CREATE TABLE a (id int, av text)",
    "CREATE TABLE b (id int, bv text)",
    "INSERT INTO a VALUES (1, 'a1'), (2, 'a2')",
    "INSERT INTO b VALUES (2, 'b2'), (3, 'b3')",
  ],
  "SELECT * FROM a NATURAL JOIN b ORDER BY id",
);
parity(
  "natural left join",
  [
    "CREATE TABLE a (id int, av text)",
    "CREATE TABLE b (id int, bv text)",
    "INSERT INTO a VALUES (1, 'a1'), (2, 'a2')",
    "INSERT INTO b VALUES (2, 'b2')",
  ],
  "SELECT * FROM a NATURAL LEFT JOIN b ORDER BY id",
);
parity(
  "natural join multiple shared columns",
  [
    "CREATE TABLE a (x int, y int, av text)",
    "CREATE TABLE b (x int, y int, bv text)",
    "INSERT INTO a VALUES (1, 1, 'p'), (1, 2, 'q')",
    "INSERT INTO b VALUES (1, 1, 'r'), (2, 2, 's')",
  ],
  "SELECT * FROM a NATURAL JOIN b ORDER BY x, y",
);
parity(
  "natural join with no shared columns is cross join",
  ["CREATE TABLE a (x int)", "CREATE TABLE b (y int)", "INSERT INTO a VALUES (1), (2)", "INSERT INTO b VALUES (9)"],
  "SELECT * FROM a NATURAL JOIN b ORDER BY x, y",
);
parity(
  "using with nulls in key never matches",
  [
    "CREATE TABLE a (id int, av text)",
    "CREATE TABLE b (id int, bv text)",
    "INSERT INTO a VALUES (NULL, 'an'), (1, 'a1')",
    "INSERT INTO b VALUES (NULL, 'bn'), (1, 'b1')",
  ],
  "SELECT id, av, bv FROM a FULL JOIN b USING (id) ORDER BY id NULLS LAST, av NULLS LAST",
);
