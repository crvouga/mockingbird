import { parity } from "../helpers.ts";

// An index lookup that finds no row answers the query at once when a miss is exact: text values
// against TEXT columns under the index's own collation. Every other shape still scans, because
// affinity or collation can make a row equal that the index keeps under a different key.

const schema = [
  "CREATE TABLE records (namespace TEXT, collection TEXT, id TEXT, seq INTEGER, value TEXT)",
  "CREATE INDEX records_seq ON records(namespace, collection, seq)",
  "INSERT INTO records VALUES ('ns','a','1',1,'x'),('ns','a','2',2,'y'),('ns','b','3',3,'z')",
];

parity(
  "an exact text prefix with no row answers empty",
  schema,
  "SELECT id FROM records WHERE namespace = 'ns' AND collection = 'missing' ORDER BY seq",
);

parity(
  "a bound text prefix with no row answers empty",
  schema,
  "SELECT id FROM records WHERE namespace = ? AND collection = ?",
  ["ns", "missing"],
);

parity(
  "a value with its own collation still finds rows equal under it",
  schema,
  "SELECT id FROM records WHERE namespace = 'NS' COLLATE NOCASE AND collection = 'a' ORDER BY seq",
);

parity(
  "a number against a TEXT column still finds the text row equal to it",
  [
    "CREATE TABLE t (k TEXT, v TEXT)",
    "CREATE INDEX t_k ON t(k)",
    "INSERT INTO t VALUES ('1','one'),('2','two')",
  ],
  "SELECT v FROM t WHERE k = 1",
);

parity(
  "a text value against a numeric column still finds the number equal to it",
  [
    "CREATE TABLE t (k INTEGER, v TEXT)",
    "CREATE INDEX t_k ON t(k)",
    "INSERT INTO t VALUES (1,'one'),(2,'two')",
  ],
  "SELECT v FROM t WHERE k = '1'",
);
