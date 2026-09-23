import { parity } from "../helpers.ts";

/** Regression: json_set with $[#] on a non-array must not hang and must leave JSON unchanged. */
parity("json_set append on object is no-op", [], `SELECT json_set('{"a":true,"b":false}', '$[#]', -3) AS v`);
