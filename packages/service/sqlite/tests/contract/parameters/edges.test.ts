import { parity } from "../helpers.ts";

parity("at-name parameters bind by slot order", [], "SELECT @left+@right value", [3, 4]);
parity("dollar-name parameters bind by slot order", [], "SELECT $left*$right value", [3, 4]);
parity("repeated anonymous parameters consume repeated values", [], "SELECT ? a,? b,? c", [7, 7, 7]);
parity(
  "named parameter can be used in a predicate",
  ["CREATE TABLE t(v INTEGER)", "INSERT INTO t VALUES (1),(2),(3)"],
  "SELECT v FROM t WHERE v>@minimum ORDER BY v",
  [1],
);
parity("mixed named prefixes occupy separate slots", [], "SELECT @x a,$x b,:x c", [1, 2, 3]);
