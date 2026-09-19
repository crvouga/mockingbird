import { parity } from "../helpers.ts";

const data = [
  "CREATE TABLE a(v INTEGER)",
  "CREATE TABLE b(v INTEGER)",
  "INSERT INTO a VALUES (1),(2),(2),(3)",
  "INSERT INTO b VALUES (2),(3),(4)",
];

parity("UNION removes duplicates", data, "SELECT v FROM a UNION SELECT v FROM b ORDER BY v");
parity("UNION ALL preserves duplicates", data, "SELECT v FROM a UNION ALL SELECT v FROM b ORDER BY v");
parity("INTERSECT returns common distinct rows", data, "SELECT v FROM a INTERSECT SELECT v FROM b ORDER BY v");
parity("EXCEPT subtracts right rows", data, "SELECT v FROM a EXCEPT SELECT v FROM b ORDER BY v");
parity(
  "compound query aliases come from first arm",
  [],
  "SELECT 1 AS value UNION ALL SELECT 2 AS ignored ORDER BY value",
);
