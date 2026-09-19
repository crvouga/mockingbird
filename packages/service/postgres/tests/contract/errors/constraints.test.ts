import { errorParity } from "../helpers.ts";

errorParity(
  "primary key duplicate fails with 23505",
  ["CREATE TABLE t (id int PRIMARY KEY)", "INSERT INTO t VALUES (1)"],
  "INSERT INTO t VALUES (1)",
  "constraint_unique",
);

errorParity(
  "unique constraint duplicate fails with 23505",
  ["CREATE TABLE t (email text UNIQUE)", "INSERT INTO t VALUES ('a@x.com')"],
  "INSERT INTO t VALUES ('a@x.com')",
  "constraint_unique",
);

errorParity(
  "UPDATE into a duplicate key fails with 23505",
  ["CREATE TABLE t (id int PRIMARY KEY)", "INSERT INTO t VALUES (1), (2)"],
  "UPDATE t SET id = 1 WHERE id = 2",
  "constraint_unique",
);

errorParity(
  "NOT NULL violation on INSERT fails with 23502",
  ["CREATE TABLE t (id int NOT NULL)"],
  "INSERT INTO t VALUES (NULL)",
  "constraint_notnull",
);

errorParity(
  "NOT NULL violation via missing column fails with 23502",
  ["CREATE TABLE t (id int NOT NULL, v text)"],
  "INSERT INTO t (v) VALUES ('x')",
  "constraint_notnull",
);

errorParity(
  "NOT NULL violation on UPDATE fails with 23502",
  ["CREATE TABLE t (id int NOT NULL)", "INSERT INTO t VALUES (1)"],
  "UPDATE t SET id = NULL",
  "constraint_notnull",
);

errorParity(
  "CHECK violation on INSERT fails with 23514",
  ["CREATE TABLE t (id int CHECK (id > 0))"],
  "INSERT INTO t VALUES (-1)",
  "constraint_check",
);

errorParity(
  "CHECK violation on UPDATE fails with 23514",
  ["CREATE TABLE t (id int CHECK (id > 0))", "INSERT INTO t VALUES (5)"],
  "UPDATE t SET id = -5",
  "constraint_check",
);

errorParity(
  "named CHECK constraint violation fails with 23514",
  ["CREATE TABLE t (qty int CONSTRAINT positive_qty CHECK (qty >= 0))"],
  "INSERT INTO t VALUES (-1)",
  "constraint_check",
);

errorParity(
  "foreign key violation on INSERT fails with 23503",
  ["CREATE TABLE p (id int PRIMARY KEY)", "CREATE TABLE c (pid int REFERENCES p(id))"],
  "INSERT INTO c VALUES (1)",
  "constraint_foreign",
);

errorParity(
  "foreign key violation on parent DELETE fails with 23503",
  [
    "CREATE TABLE p (id int PRIMARY KEY)",
    "CREATE TABLE c (pid int REFERENCES p(id))",
    "INSERT INTO p VALUES (1)",
    "INSERT INTO c VALUES (1)",
  ],
  "DELETE FROM p WHERE id = 1",
  "constraint_foreign",
);
