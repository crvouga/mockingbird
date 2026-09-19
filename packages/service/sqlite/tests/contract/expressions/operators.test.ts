import { parity } from "../helpers.ts";

parity("arithmetic and concatenation operators", [], "SELECT 7+3 a,7-3 b,7*3 c,7/3 d,7%3 e,'ab'||'cd' f");
parity("boolean precedence", [], "SELECT 1 OR 0 AND 0 a,(1 OR 0) AND 0 b,NOT 0 c");
parity("NOT binds looser than comparison", [], "SELECT (NOT 2 <= 1) a,((NOT 2) <= 1) b,(NOT 543 <= 366) c");
parity(
  "searched and simple CASE",
  [],
  "SELECT CASE WHEN 2>1 THEN 'yes' ELSE 'no' END a,CASE 2 WHEN 1 THEN 'a' WHEN 2 THEN 'b' END b",
);
parity(
  "CAST across common storage classes",
  [],
  "SELECT CAST('12' AS INTEGER) i,CAST('2.5' AS REAL) r,CAST(9 AS TEXT) t,typeof(CAST('4' AS NUMERIC)) n",
);
parity(
  "BETWEEN and IN predicates",
  [],
  "SELECT 3 BETWEEN 2 AND 4 a,1 NOT BETWEEN 2 AND 4 b,3 IN (1,3,5) c,2 NOT IN (1,3,5) d",
);
parity(
  "LIKE escaping and case behavior",
  [],
  "SELECT 'Alpha' LIKE 'a%' a,'a_b' LIKE 'a!_b' ESCAPE '!' b,'abc' NOT LIKE 'd%' c",
);
parity("GLOB uses shell-style patterns", [], "SELECT 'Alpha' GLOB 'A*' a,'abc' GLOB 'a?c' b,'abc' GLOB 'A*' c");
