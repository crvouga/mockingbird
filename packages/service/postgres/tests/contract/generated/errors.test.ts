import { errorParity } from "../helpers.ts";

errorParity(
  "cannot insert into generated column",
  ["CREATE TABLE t (a int, b int GENERATED ALWAYS AS (a * 2) STORED)"],
  "INSERT INTO t (a, b) VALUES (1, 99)",
);

errorParity(
  "cannot update generated column",
  ["CREATE TABLE t (a int, b int GENERATED ALWAYS AS (a * 2) STORED)", "INSERT INTO t (a) VALUES (1)"],
  "UPDATE t SET b = 99",
);

errorParity(
  "generated column violating check constraint",
  ["CREATE TABLE t (a int, b int GENERATED ALWAYS AS (a * 2) STORED CHECK (b < 100))"],
  "INSERT INTO t (a) VALUES (60)",
  "constraint_check",
);

errorParity(
  "unique constraint on generated column",
  ["CREATE TABLE t (a int, half int GENERATED ALWAYS AS (a / 2) STORED UNIQUE)", "INSERT INTO t (a) VALUES (4)"],
  "INSERT INTO t (a) VALUES (5)",
  "constraint_unique",
);

errorParity(
  "not-null generated column rejects null result",
  ["CREATE TABLE t (v text, up text GENERATED ALWAYS AS (upper(v)) STORED NOT NULL)"],
  "INSERT INTO t (v) VALUES (NULL)",
  "constraint_notnull",
);
