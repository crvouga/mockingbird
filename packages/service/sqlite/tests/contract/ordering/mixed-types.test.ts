import { parity } from "../helpers.ts";

parity(
  "ORDER BY mixed storage classes uses NULL < number < text < blob",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, v)", "INSERT INTO t(id, v) VALUES (1, 1), (2, 'a'), (3, X'41'), (4, NULL)"],
  "SELECT id FROM t ORDER BY v, id",
);
