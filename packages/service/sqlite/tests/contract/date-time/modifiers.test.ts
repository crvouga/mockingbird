import { divergence, parity } from "../helpers.ts";

parity("datetime subsec includes fractional seconds", [], "SELECT datetime('2024-01-01 12:00:00.123','subsec') AS v");

parity("time subsec includes fractional seconds", [], "SELECT time('2024-01-01 12:00:00.123','subsec') AS v");

parity("datetime auto interprets unix timestamp by magnitude", [], "SELECT datetime(1704110400,'auto') AS v");

parity("datetime auto interprets julian day by magnitude", [], "SELECT datetime(2460310.5,'auto') AS v");

parity(
  "datetime floor and ceiling modifiers are accepted",
  [],
  "SELECT datetime('2024-01-01 12:00:00.400','floor','subsec') AS f, datetime('2024-01-01 12:00:00.400','ceiling','subsec') AS c",
);

parity(
  "utc and localtime modifiers are accepted without error",
  [],
  "SELECT datetime('2024-06-01 15:30:00','utc') IS NOT NULL AS ok",
);

divergence(
  "datetime-localtime-utc",
  "localtime/utc are intentional no-ops (engine stores UTC; oracle applies TZ conversion)",
  (db) => {
    const row = db.query<{ loc: string; u: string }>(
      "SELECT datetime('2024-06-01 15:30:00','localtime') AS loc, datetime('2024-06-01 15:30:00','utc') AS u",
    )[0]!;
    // Fixed wall-clock identity — not host TZ conversion.
    if (row.loc !== "2024-06-01 15:30:00" || row.u !== "2024-06-01 15:30:00") {
      throw new Error(`unexpected localtime/utc result: ${JSON.stringify(row)}`);
    }
  },
);
