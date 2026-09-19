import { parity } from "../helpers.ts";

parity(
  "blob literal has blob storage class",
  [],
  "SELECT X'00CAFEFF' AS value,typeof(X'00CAFEFF') AS kind,length(X'00CAFEFF') AS size",
);
parity(
  "blob roundtrips through table storage",
  ["CREATE TABLE t(id INTEGER,data BLOB)", "INSERT INTO t VALUES (1,X'000102FF'),(2,X'')"],
  "SELECT id,data,hex(data) AS encoded,length(data) AS size FROM t ORDER BY id",
);
parity("blob equality compares bytes", [], "SELECT X'ABCD'=X'ABCD' AS same,X'ABCD'=X'ABCE' AS different");
parity("hex converts text and blob bytes", [], "SELECT hex(X'DEADBEEF') AS blob_hex,hex('Az') AS text_hex");
