import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "SET timezone changes timestamptz text output",
  [],
  [
    { sql: "SET timezone = 'UTC'" },
    { sql: "SELECT TIMESTAMPTZ '2020-01-01 12:00:00+00' AS v", query: true },
    { sql: "SET timezone = 'America/New_York'" },
    { sql: "SELECT TIMESTAMPTZ '2020-01-01 12:00:00+00' AS v", query: true },
  ],
);

sequenceParity(
  "SHOW timezone echoes the setting",
  [],
  [{ sql: "SET timezone = 'America/Chicago'" }, { sql: "SHOW timezone", query: true }],
);

sequenceParity(
  "AT TIME ZONE with an explicit timestamp is unaffected by the session zone name change",
  [],
  [
    { sql: "SET timezone = 'UTC'" },
    { sql: "SELECT TIMESTAMP '2021-06-01 00:00:00' AT TIME ZONE 'America/Denver' AS v", query: true },
  ],
);

sequenceParity(
  "AT TIME ZONE converts timestamptz to a session-independent timestamp",
  [],
  [
    { sql: "SET timezone = 'America/Los_Angeles'" },
    { sql: "SELECT TIMESTAMPTZ '2021-06-01 12:00:00+00' AT TIME ZONE 'UTC' AS v", query: true },
  ],
);

sequenceParity(
  "session timezone affects AT TIME ZONE output rendering of timestamptz results",
  [],
  [
    { sql: "SET timezone = 'America/Chicago'" },
    { sql: "SELECT TIMESTAMP '2021-06-01 00:00:00' AT TIME ZONE 'UTC' AS v", query: true },
    { sql: "SET timezone = 'UTC'" },
    { sql: "SELECT TIMESTAMP '2021-06-01 00:00:00' AT TIME ZONE 'UTC' AS v", query: true },
  ],
);

sequenceParity(
  "SET TIME ZONE syntax variant",
  [],
  [{ sql: "SET TIME ZONE 'UTC'" }, { sql: "SHOW timezone", query: true }],
);

sequenceParity(
  "RESET timezone",
  [],
  [
    { sql: "SET timezone = 'America/New_York'" },
    { sql: "RESET timezone" },
    { sql: "SELECT TIMESTAMPTZ '2020-06-01 00:00:00+00' AS v", query: true },
  ],
);

sequenceParity(
  "timezone winter vs summer offsets",
  [],
  [
    { sql: "SET timezone = 'America/New_York'" },
    {
      sql: "SELECT TIMESTAMPTZ '2020-01-15 12:00:00+00' AS winter, TIMESTAMPTZ '2020-07-15 12:00:00+00' AS summer",
      query: true,
    },
  ],
);

sequenceParity(
  "extra_float_digits setting is accepted",
  [],
  [{ sql: "SET extra_float_digits = 0" }, { sql: "SELECT 0.1::float8::text AS v", query: true }],
);
