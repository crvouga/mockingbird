import { parity } from "../helpers.ts";

parity(
  "weekday modifier advances to requested weekday",
  [],
  "SELECT date('2024-08-19','weekday 0') AS sunday, date('2024-08-19','weekday 1') AS monday",
);

parity("weekday modifier composes with other modifiers", [], "SELECT date('2024-08-19','weekday 5','+1 day') AS value");

parity(
  "weekday modifier rejects values outside zero through six",
  [],
  "SELECT date('2024-08-19','weekday 7') AS value",
);
