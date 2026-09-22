import { parity, parityTyped } from "../helpers.ts";

parity("integer parameter", [], "SELECT $1::int AS v", [42]);

parity("negative integer parameter", [], "SELECT $1::int AS v", [-7]);

parity("bigint parameter from a JS bigint", [], "SELECT $1::bigint AS v", [9007199254740993n]);

parity("text parameter", [], "SELECT $1::text AS v", ["hello world"]);

parity("text parameter with quotes inside", [], "SELECT $1::text AS v", ['it\'s "quoted"']);

parity("boolean true parameter", [], "SELECT $1::boolean AS v", [true]);

parity("boolean false parameter", [], "SELECT $1::boolean AS v", [false]);

parity("null parameter is NULL", [], "SELECT $1::int IS NULL AS v", [null]);

parity("null text parameter", [], "SELECT coalesce($1::text, 'fallback') AS v", [null]);

parity("float parameter", [], "SELECT $1::float8 AS v", [1.5]);

parity("numeric string parameter", [], "SELECT $1::numeric AS v", ["12.34"]);

parity("parameter used twice", [], "SELECT $1::int + $1::int AS v", [21]);

parity("multiple parameters in order", [], "SELECT $1::int AS a, $2::text AS b, $3::boolean AS c", [1, "x", true]);

parity("parameters used out of order", [], "SELECT $2::text AS b, $1::int AS a", [1, "x"]);

parity("parameter in arithmetic", [], "SELECT $1::int * 2 + $2::int AS v", [10, 3]);

parity("parameter in string concatenation", [], "SELECT $1::text || '-' || $2::text AS v", ["a", "b"]);

parityTyped("typed int parameter", [], "SELECT $1::int AS v", [5]);

parityTyped("typed text parameter", [], "SELECT $1::text AS v", ["t"]);
