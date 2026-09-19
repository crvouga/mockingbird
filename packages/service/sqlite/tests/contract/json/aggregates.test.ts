import { parity } from "../helpers.ts";

parity(
  "json_group_array basic",
  ["CREATE TABLE t(v)", "INSERT INTO t VALUES (1), (2), (NULL), (3)"],
  `SELECT json_group_array(v) FROM t`,
);

parity(
  "json_group_object basic",
  ["CREATE TABLE t(k TEXT, v)", "INSERT INTO t VALUES ('a', 1), ('b', 2)"],
  `SELECT json_group_object(k, v) FROM t`,
);

parity("json_group_array empty", ["CREATE TABLE t(v)"], `SELECT json_group_array(v) FROM t`);

parity(
  "json_group_array with order",
  ["CREATE TABLE t(v)", "INSERT INTO t VALUES (3), (1), (2)"],
  `SELECT json_group_array(v) AS a FROM (SELECT v FROM t ORDER BY v) AS s`,
);

parity(
  "json_group_object duplicate keys",
  ["CREATE TABLE t(k TEXT, v)", "INSERT INTO t VALUES ('a', 1), ('a', 2)"],
  `SELECT json_group_object(k, v) FROM t`,
);
