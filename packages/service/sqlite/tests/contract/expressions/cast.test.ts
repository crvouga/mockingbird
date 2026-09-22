import { parity } from "../helpers.ts";

parity("CAST empty string to INTEGER is 0", [], "SELECT CAST('' AS INTEGER) i, typeof(CAST('' AS INTEGER)) t");

parity(
  "CAST text to BLOB yields utf8 bytes",
  [],
  "SELECT typeof(CAST('hi' AS BLOB)) t, length(CAST('hi' AS BLOB)) n, hex(CAST('hi' AS BLOB)) h",
);

parity(
  "CAST NULL preserves NULL across affinities",
  [],
  "SELECT CAST(NULL AS INTEGER) i, CAST(NULL AS TEXT) t, CAST(NULL AS BLOB) b, CAST(NULL AS REAL) r",
);

parity(
  "CAST uses type-name affinity rules",
  [],
  "SELECT typeof(CAST('12.5' AS INT)) a, typeof(CAST('12.5' AS VARCHAR(10))) b, typeof(CAST('12.5' AS FLOAT)) c",
);

parity("CAST blob to TEXT decodes utf8", [], "SELECT CAST(X'6869' AS TEXT) value");
