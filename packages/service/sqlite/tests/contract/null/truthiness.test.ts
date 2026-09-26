import { parity } from "../helpers.ts";

parity("text '0' is false in CASE WHEN", [], "SELECT CASE WHEN '0' THEN 1 ELSE 0 END a");
parity("text '1' is true in CASE WHEN", [], "SELECT CASE WHEN '1' THEN 1 ELSE 0 END a");
parity("non-numeric text is false in CASE WHEN", [], "SELECT CASE WHEN 'hello' THEN 1 ELSE 0 END a");
parity("empty text is false in CASE WHEN", [], "SELECT CASE WHEN '' THEN 1 ELSE 0 END a");
parity("zero blob is false in CASE WHEN", [], "SELECT CASE WHEN X'00' THEN 1 ELSE 0 END a");
parity("ascii digit blob is true in CASE WHEN", [], "SELECT CASE WHEN X'31' THEN 1 ELSE 0 END a");
parity("AND uses numeric text truthiness", [], "SELECT '0' AND 1 a, '1' AND 1 b, 'x' AND 1 c");
parity(
  "WHERE filters with numeric text truthiness",
  ["CREATE TABLE t(v TEXT)", "INSERT INTO t VALUES ('0'),('1'),('hello'),('')"],
  "SELECT v FROM t WHERE v ORDER BY v",
);
