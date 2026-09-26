import { parity, queryErrorParity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "set_config sets a GUC and returns the new value",
  [],
  [
    { sql: "SELECT set_config('application_name', 'via_fn', false) AS v", query: true },
    { sql: "SHOW application_name", query: true },
    { sql: "SELECT current_setting('application_name') AS v", query: true },
  ],
);

sequenceParity(
  "current_setting reads a value set by SET",
  [],
  [
    { sql: "SET application_name = 'from_set'" },
    { sql: "SELECT current_setting('application_name') AS v", query: true },
  ],
);

parity(
  "current_setting with missing_ok true returns NULL for unknown GUC",
  [],
  "SELECT current_setting('no.such.setting', true) AS v",
);

parity(
  "current_setting with missing_ok false errors like the one-argument form",
  [],
  "SELECT current_setting('application_name', false) IS NOT NULL AS present",
);

queryErrorParity(
  "current_setting of an unknown GUC fails with 42704",
  [],
  "SELECT current_setting('no.such.thing')",
  "undefined_object",
);

queryErrorParity("SHOW of an unknown GUC fails with 42704", [], "SHOW nonexistent_gucname", "undefined_object");

sequenceParity(
  "set_config on a custom two-part GUC name",
  [],
  [
    { sql: "SELECT set_config('myapp.tenant', 'acme', false) AS v", query: true },
    { sql: "SELECT current_setting('myapp.tenant') AS v", query: true },
  ],
);

sequenceParity(
  "custom GUC readable with missing_ok before and after being set",
  [],
  [
    // name must be unique to this file: a custom GUC can never become undefined
    // again within the shared oracle session once any test defines it
    { sql: "SELECT current_setting('setshow.flag', true) AS v", query: true },
    { sql: "SELECT set_config('setshow.flag', 'on', false) AS v", query: true },
    { sql: "SELECT current_setting('setshow.flag', true) AS v", query: true },
  ],
);

sequenceParity(
  "set_config non-local inside a committed transaction persists",
  [],
  [
    { sql: "BEGIN" },
    { sql: "SELECT set_config('application_name', 'committed', false) AS v", query: true },
    { sql: "COMMIT" },
    { sql: "SHOW application_name", query: true },
  ],
);

sequenceParity(
  "search_path is readable through current_setting",
  ["CREATE SCHEMA cfg"],
  [{ sql: "SET search_path TO cfg, public" }, { sql: "SELECT current_setting('search_path') AS v", query: true }],
);
