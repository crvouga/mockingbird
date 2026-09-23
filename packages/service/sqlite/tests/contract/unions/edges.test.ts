import { parity, queryErrorParity } from "../helpers.ts";

queryErrorParity("UNION arms require equal column counts", [], "SELECT 1 UNION SELECT 2,3", "other");
queryErrorParity("UNION ALL arms require equal column counts", [], "SELECT 1,2 UNION ALL SELECT 3", "other");
parity("ORDER BY applies after UNION deduplication", [], "SELECT 3 v UNION SELECT 1 UNION SELECT 2 ORDER BY v DESC");
parity("ORDER BY ordinal applies to compound result", [], "SELECT 'b' k,2 n UNION ALL SELECT 'a',1 ORDER BY 2,1");
parity(
  "LIMIT applies after compound ORDER BY",
  [],
  "SELECT 3 v UNION ALL SELECT 1 UNION ALL SELECT 2 ORDER BY v LIMIT 2",
);
