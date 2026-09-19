import { parity } from "../helpers.ts";

parity("bitwise operators coerce integer operands", [], "SELECT 6&3 a,6|3 b,1<<4 c,16>>2 d");
parity(
  "nested CASE expressions select inner branches",
  [],
  "SELECT CASE WHEN 2>1 THEN CASE 3 WHEN 3 THEN 'hit' ELSE 'miss' END ELSE 'outer' END value",
);
parity(
  "LIKE ESCAPE quotes wildcard characters",
  [],
  "SELECT 'a%b' LIKE 'a!%b' ESCAPE '!' a,'a_b' LIKE 'a!_b' ESCAPE '!' b,'axb' LIKE 'a!_b' ESCAPE '!' c",
);
parity(
  "GLOB bracket classes and negation",
  [],
  "SELECT 'b' GLOB '[abc]' a,'d' GLOB '[a-c]' b,'z' GLOB '[^a-c]' c,'5' GLOB '[0-9]' d",
);
parity(
  "BETWEEN propagates NULL where outcome is unknown",
  [],
  "SELECT 2 BETWEEN NULL AND 3 a,2 BETWEEN 1 AND NULL b,NULL BETWEEN 1 AND 3 c,0 BETWEEN NULL AND 3 d",
);
