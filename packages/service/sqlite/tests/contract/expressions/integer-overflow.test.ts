import { parity, parityTyped } from "../helpers.ts";

parity("integer addition beyond i64 promotes to REAL", [], "SELECT 9223372036854775807 + 1 AS v");

parityTyped("integer addition beyond i64 is REAL type", [], "SELECT typeof(9223372036854775807 + 1) AS t");

parity("integer multiplication near i64 max", [], "SELECT 3037000500 * 3037000500 AS v");
