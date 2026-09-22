import { queryErrorParity, sequenceParity } from "../helpers.ts";

queryErrorParity("incomplete object", [], `SELECT json('{')`);
queryErrorParity("incomplete array", [], `SELECT json('[1,')`);
queryErrorParity("invalid string", [], `SELECT json('"unterminated')`);
queryErrorParity("trailing garbage", [], `SELECT json('{"a":1}x')`);
queryErrorParity("invalid path in extract", [], `SELECT json_extract('[1]', '[0]')`);

sequenceParity(
  "malformed json does not commit surrounding txn effects incorrectly",
  ["CREATE TABLE t(x)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SELECT json('{')", query: true },
    { sql: "COMMIT" },
    { sql: "SELECT * FROM t", query: true },
  ],
  { compareFinalState: true },
);
