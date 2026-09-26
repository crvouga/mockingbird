import { type CatalogSection, section } from "../scenario-types.ts";

export const ERR_SECTION: CatalogSection = section("ERR", "Error parity", true, [
  ["syn-01", "42601 syntax error category"],
  ["tab-01", "42P01 undefined table"],
  ["col-01", "42703 undefined column"],
  ["fn-01", "42883 undefined function"],
  ["div-01", "22012 division by zero"],
  ["text-01", "22P02 invalid text representation"],
  ["uniq-01", "23505 unique violation"],
  ["null-01", "23502 not-null violation"],
  ["check-01", "23514 check violation"],
  ["range-01", "22003 numeric value out of range"],
  ["state-01", "a failed statement leaves the session usable"],
  ["state-02", "a constraint failure leaves the table writable"],
]);
