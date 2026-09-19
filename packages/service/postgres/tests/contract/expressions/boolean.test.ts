import { parity } from "../helpers.ts";

parity("and truth table", [], "SELECT true AND true AS a, true AND false AS b, false AND false AS c");
parity("or truth table", [], "SELECT true OR false AS a, false OR false AS b, true OR true AS c");
parity("not operator", [], "SELECT NOT true AS a, NOT false AS b");
parity("three valued and with null", [], "SELECT true AND NULL AS a, false AND NULL AS b, NULL AND NULL AS c");
parity("three valued or with null", [], "SELECT true OR NULL AS a, false OR NULL AS b, NULL OR NULL AS c");
parity("not of null", [], "SELECT NOT NULL::boolean AS v");
parity(
  "is true and is false",
  [],
  "SELECT (NULL::boolean) IS TRUE AS a, (NULL::boolean) IS FALSE AS b, true IS TRUE AS c",
);
parity("is not true", [], "SELECT (NULL::boolean) IS NOT TRUE AS a, false IS NOT TRUE AS b");
parity("is unknown", [], "SELECT (NULL::boolean) IS UNKNOWN AS a, true IS UNKNOWN AS b");
parity("is not unknown", [], "SELECT (NULL::boolean) IS NOT UNKNOWN AS a, true IS NOT UNKNOWN AS b");
parity(
  "comparison yields boolean",
  [],
  "SELECT 1 < 2 AS a, 2 <= 2 AS b, 3 > 4 AS c, 3 >= 4 AS d, 1 = 1 AS e, 1 <> 2 AS f",
);
parity("alternative not equals operator", [], "SELECT 1 != 2 AS a, 1 != 1 AS b");
parity("boolean comparison ordering", [], "SELECT false < true AS a, true > false AS b");
parity("and or precedence", [], "SELECT true OR false AND false AS v");
parity("not precedence", [], "SELECT NOT false AND false AS v");
parity(
  "boolean aggregates",
  ["CREATE TABLE t (v bool)", "INSERT INTO t VALUES (true), (false), (true)"],
  "SELECT bool_and(v) AS a, bool_or(v) AS b, count(*) FILTER (WHERE v) AS c FROM t",
);
