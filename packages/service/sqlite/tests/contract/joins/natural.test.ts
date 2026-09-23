import { parity } from "../helpers.ts";

const data = [
  "CREATE TABLE users(user_id INTEGER, name TEXT)",
  "CREATE TABLE posts(user_id INTEGER, title TEXT)",
  "INSERT INTO users VALUES (1,'Ada'),(2,'Bob'),(3,'Cy')",
  "INSERT INTO posts VALUES (1,'A'),(1,'B'),(2,'C')",
];

parity(
  "NATURAL JOIN matches on shared column names",
  [
    "CREATE TABLE a(id INTEGER, av TEXT)",
    "CREATE TABLE b(id INTEGER, bv TEXT)",
    "INSERT INTO a VALUES (1,'a'),(2,'b')",
    "INSERT INTO b VALUES (2,'B'),(3,'C')",
  ],
  "SELECT id,av,bv FROM a NATURAL JOIN b ORDER BY id",
);

parity(
  "NATURAL LEFT JOIN null-extends unmatched left rows",
  [
    "CREATE TABLE a(id INTEGER, av TEXT)",
    "CREATE TABLE b(id INTEGER, bv TEXT)",
    "INSERT INTO a VALUES (1,'a'),(2,'b')",
    "INSERT INTO b VALUES (2,'B'),(3,'C')",
  ],
  "SELECT id,av,bv FROM a NATURAL LEFT JOIN b ORDER BY id",
);

parity(
  "NATURAL JOIN with no shared columns is a cartesian product",
  [
    "CREATE TABLE a(x INTEGER)",
    "CREATE TABLE b(y INTEGER)",
    "INSERT INTO a VALUES (1),(2)",
    "INSERT INTO b VALUES (10)",
  ],
  "SELECT x,y FROM a NATURAL JOIN b ORDER BY x",
);

parity(
  "NATURAL JOIN projects shared and remaining columns",
  data,
  "SELECT user_id, name, title FROM users NATURAL JOIN posts ORDER BY user_id, title",
);

parity(
  "NATURAL FULL OUTER JOIN keeps right values on unmatched right rows",
  [
    "CREATE TABLE a(id INTEGER, av TEXT)",
    "CREATE TABLE b(id INTEGER, bv TEXT)",
    "INSERT INTO a VALUES (1,'a')",
    "INSERT INTO b VALUES (1,'A'),(2,'B')",
  ],
  "SELECT id, av, bv FROM a NATURAL FULL OUTER JOIN b ORDER BY id",
);
