import { parity, parityTyped } from "../helpers.ts";

parity("make_date", [], "SELECT make_date(2024, 3, 15) AS v");
parity("make_date medieval", [], "SELECT make_date(1, 1, 1) AS v");
parity("make_time", [], "SELECT make_time(13, 30, 45.5) AS v");
parity("make_timestamp", [], "SELECT make_timestamp(2024, 3, 15, 13, 30, 45.5) AS v");
parity("to_char date iso", [], "SELECT to_char(date '2024-03-15', 'YYYY-MM-DD') AS v");
parity("to_char month and day names", [], "SELECT to_char(date '2024-03-15', 'Month Day') AS v");
parity("to_char abbreviated names", [], "SELECT to_char(date '2024-03-15', 'Mon Dy') AS v");
parity("to_char with time fields", [], "SELECT to_char(timestamp '2024-03-15 13:05:09', 'HH24:MI:SS') AS v");
parity("to_char twelve hour clock", [], "SELECT to_char(timestamp '2024-03-15 13:05:09', 'HH12:MI AM') AS v");
parity("to_char day of year and week", [], "SELECT to_char(date '2024-03-15', 'DDD WW D') AS v");
parity("to_date basic", [], "SELECT to_date('15 Mar 2024', 'DD Mon YYYY') AS v");
parityTyped("make_date type", [], "SELECT make_date(2024, 1, 1) AS v");
parity("isfinite on dates", [], "SELECT isfinite(date '2024-01-01') AS a, isfinite('infinity'::date) AS b");
parity(
  "date least and greatest",
  [],
  "SELECT least(date '2024-01-01', date '2023-06-01') AS a, greatest(date '2024-01-01', date '2023-06-01') AS b",
);
