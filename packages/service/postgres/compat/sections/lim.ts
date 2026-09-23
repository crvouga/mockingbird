import { type CatalogSection, section } from "../scenario-types.ts";

export const LIM_SECTION: CatalogSection = section("LIM", "Limits & pathological inputs", true, [
  ["depth-01", "deeply parenthesized expression"],
  ["cmpd-01", "many UNION ALL terms"],
  ["cols-01", "many columns per table"],
  ["vals-01", "many VALUES rows"],
  ["in-01", "large IN list"],
  ["ident-01", "long identifiers"],
  ["zero-01", "empty table and empty-string key"],
  ["zero-02", "SELECT with no FROM"],
  ["null-01", "all-NULL rows through aggregates"],
]);
