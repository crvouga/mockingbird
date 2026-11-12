import { parity } from "../helpers.ts";

// #684: pg_timezone_names / pg_timezone_abbrevs (zones without daylight saving time, so the answer
// does not depend on the date the suite runs)

parity(
  "pg_timezone_names has a zone AT TIME ZONE accepts",
  [],
  "SELECT name FROM pg_timezone_names WHERE name = 'America/Phoenix'",
);

parity(
  "pg_timezone_names lists the whole tz database",
  [],
  "SELECT count(*) > 300 AS has_names FROM pg_timezone_names",
);

parity(
  "pg_timezone_names reports abbreviation, offset and DST",
  [],
  `SELECT name, abbrev, utc_offset::text, is_dst FROM pg_timezone_names
   WHERE name IN ('UTC', 'America/Phoenix', 'Asia/Kolkata', 'Etc/GMT+7', 'Asia/Tokyo') ORDER BY name`,
);

parity(
  "pg_timezone_abbrevs lists the Default abbreviation set",
  [],
  `SELECT abbrev, utc_offset::text, is_dst FROM pg_timezone_abbrevs
   WHERE abbrev IN ('EST', 'EDT', 'UTC', 'CEST', 'IST', 'JST') ORDER BY abbrev`,
);

parity("pg_timezone_abbrevs row count", [], "SELECT count(*)::int AS n FROM pg_timezone_abbrevs");

parity(
  "a stored zone is validated against pg_timezone_names",
  ["CREATE TABLE tz_users (zone text)", "INSERT INTO tz_users VALUES ('America/Phoenix'), ('Mars/Olympus')"],
  "SELECT u.zone, n.name IS NOT NULL AS known FROM tz_users u LEFT JOIN pg_timezone_names n ON n.name = u.zone ORDER BY u.zone",
);
