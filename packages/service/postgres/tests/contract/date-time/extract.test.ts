import { parity, parityTyped } from "../helpers.ts";

parity(
  "extract date fields",
  [],
  "SELECT extract(year FROM date '2024-03-15') AS y, extract(month FROM date '2024-03-15') AS m, " +
    "extract(day FROM date '2024-03-15') AS d",
);
parity(
  "extract time fields from timestamp",
  [],
  "SELECT extract(hour FROM timestamp '2024-03-15 13:45:30.5') AS h, " +
    "extract(minute FROM timestamp '2024-03-15 13:45:30.5') AS m, " +
    "extract(second FROM timestamp '2024-03-15 13:45:30.5') AS s",
);
parity(
  "extract dow and isodow",
  [],
  "SELECT extract(dow FROM date '2024-03-17') AS a, extract(isodow FROM date '2024-03-17') AS b",
);
parity(
  "extract doy and week",
  [],
  "SELECT extract(doy FROM date '2024-03-15') AS a, extract(week FROM date '2024-03-15') AS b",
);
parity(
  "extract quarter",
  [],
  "SELECT extract(quarter FROM date '2024-03-31') AS a, extract(quarter FROM date '2024-04-01') AS b",
);
parity(
  "extract century decade millennium",
  [],
  "SELECT extract(century FROM date '2024-01-01') AS a, extract(decade FROM date '2024-01-01') AS b, extract(millennium FROM date '2024-01-01') AS c",
);
parity(
  "extract isoyear at year boundary",
  [],
  "SELECT extract(isoyear FROM date '2024-01-01') AS a, extract(isoyear FROM date '2022-01-01') AS b",
);
parity("extract epoch from timestamp", [], "SELECT extract(epoch FROM timestamp '2024-01-15 00:00:00') AS v");
parity("extract epoch from date", [], "SELECT extract(epoch FROM date '1970-01-02') AS v");
parityTyped("extract returns numeric", [], "SELECT extract(year FROM date '2024-03-15') AS v");
parity(
  "date_part equivalent",
  [],
  "SELECT date_part('year', date '2024-03-15') AS a, date_part('month', date '2024-03-15') AS b",
);
parityTyped("date_part returns float8", [], "SELECT date_part('day', date '2024-03-15') AS v");
parity(
  "date_trunc month and year",
  [],
  "SELECT date_trunc('month', timestamp '2024-03-15 13:45:30') AS a, date_trunc('year', timestamp '2024-03-15 13:45:30') AS b",
);
parity(
  "date_trunc day hour minute",
  [],
  "SELECT date_trunc('day', timestamp '2024-03-15 13:45:30') AS a, date_trunc('hour', timestamp '2024-03-15 13:45:30') AS b, date_trunc('minute', timestamp '2024-03-15 13:45:30') AS c",
);
parity(
  "date_trunc week and quarter",
  [],
  "SELECT date_trunc('week', timestamp '2024-03-15 13:45:30') AS a, date_trunc('quarter', timestamp '2024-03-15 13:45:30') AS b",
);
