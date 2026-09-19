import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "SET and SHOW application_name",
  [],
  [{ sql: "SET application_name = 'my_app'" }, { sql: "SHOW application_name", query: true }],
);

sequenceParity(
  "SET application_name TO form",
  [],
  [{ sql: "SET application_name TO 'to_form'" }, { sql: "SHOW application_name", query: true }],
);

sequenceParity(
  "RESET application_name returns to the default",
  [],
  [
    { sql: "SET application_name = 'temp_name'" },
    { sql: "RESET application_name" },
    { sql: "SHOW application_name", query: true },
  ],
);

sequenceParity(
  "SET TO DEFAULT behaves like RESET",
  [],
  [
    { sql: "SET application_name = 'temp_name'" },
    { sql: "SET application_name TO DEFAULT" },
    { sql: "SHOW application_name", query: true },
  ],
);

sequenceParity(
  "RESET ALL restores defaults",
  [],
  [{ sql: "SET application_name = 'zzz'" }, { sql: "RESET ALL" }, { sql: "SHOW application_name", query: true }],
);

sequenceParity(
  "overwrite a GUC set earlier in the session",
  [],
  [
    { sql: "SET application_name = 'first'" },
    { sql: "SET application_name = 'second'" },
    { sql: "SHOW application_name", query: true },
  ],
);

sequenceParity("SHOW server_version returns the oracle version", [], [{ sql: "SHOW server_version", query: true }]);

sequenceParity(
  "SET DateStyle changes date output",
  [],
  [
    { sql: "SET DateStyle = 'ISO, DMY'" },
    { sql: "SELECT '2021-02-03'::date::text AS v", query: true },
    { sql: "SHOW DateStyle", query: true },
  ],
);

sequenceParity(
  "SET in an aborted-free transaction persists after COMMIT",
  [],
  [
    { sql: "BEGIN" },
    { sql: "SET application_name = 'txn_value'" },
    { sql: "COMMIT" },
    { sql: "SHOW application_name", query: true },
  ],
);

sequenceParity(
  "SET inside a rolled-back transaction reverts",
  [],
  [
    { sql: "SET application_name = 'outer'" },
    { sql: "BEGIN" },
    { sql: "SET application_name = 'inner'" },
    { sql: "ROLLBACK" },
    { sql: "SHOW application_name", query: true },
  ],
);

sequenceParity(
  "SET LOCAL reverts after COMMIT",
  [],
  [
    { sql: "SET application_name = 'outer'" },
    { sql: "BEGIN" },
    { sql: "SET LOCAL application_name = 'inner'" },
    { sql: "SHOW application_name", query: true },
    { sql: "COMMIT" },
    { sql: "SHOW application_name", query: true },
  ],
);

sequenceParity(
  "SET LOCAL outside a transaction has no lasting effect",
  [],
  [
    { sql: "SET application_name = 'base'" },
    { sql: "SET LOCAL application_name = 'ephemeral'" },
    { sql: "SHOW application_name", query: true },
  ],
);
