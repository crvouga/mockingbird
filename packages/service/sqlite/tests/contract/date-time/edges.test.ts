import { parity } from "../helpers.ts";

parity("datetime adds one day across month boundary", [], "SELECT datetime('2001-05-31 12:30:00','+1 day') value");
parity(
  "datetime start of month resets date and time",
  [],
  "SELECT datetime('2001-05-15 12:34:56','start of month') value",
);
parity("date applies chained fixed modifiers", [], "SELECT date('2001-05-15','start of month','+1 day') value");
parity("datetime negative day modifier is deterministic", [], "SELECT datetime('2001-05-15','-1 day') value");
parity("start of month is idempotent", [], "SELECT datetime('2001-05-15','start of month','start of month') value");
