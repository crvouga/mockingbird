import { errorParity } from "../helpers.ts";

errorParity(
  "DO UPDATE requires conflict target",
  ["CREATE TABLE t (id int PRIMARY KEY)", "INSERT INTO t VALUES (1)"],
  "INSERT INTO t VALUES (1) ON CONFLICT DO UPDATE SET id = 2",
  "syntax",
);

errorParity(
  "conflict target without matching unique constraint",
  ["CREATE TABLE t (id int, v text)"],
  "INSERT INTO t VALUES (1, 'a') ON CONFLICT (id) DO NOTHING",
);

errorParity(
  "ON CONSTRAINT with unknown constraint name",
  ["CREATE TABLE t (id int PRIMARY KEY)"],
  "INSERT INTO t VALUES (1) ON CONFLICT ON CONSTRAINT nope DO NOTHING",
);

errorParity(
  "DO UPDATE cannot violate another unique constraint",
  ["CREATE TABLE t (id int PRIMARY KEY, email text UNIQUE)", "INSERT INTO t VALUES (1, 'a@x.com'), (2, 'b@x.com')"],
  "INSERT INTO t VALUES (1, 'z@x.com') ON CONFLICT (id) DO UPDATE SET email = 'b@x.com'",
  "constraint_unique",
);

errorParity(
  "DO UPDATE cannot set null on not-null column",
  ["CREATE TABLE t (id int PRIMARY KEY, v text NOT NULL)", "INSERT INTO t VALUES (1, 'x')"],
  "INSERT INTO t VALUES (1, 'y') ON CONFLICT (id) DO UPDATE SET v = NULL",
  "constraint_notnull",
);
