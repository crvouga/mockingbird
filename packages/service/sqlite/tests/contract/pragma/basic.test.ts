import { parity, sequenceParity } from "../helpers.ts";

parity("foreign_keys returns 0 when disabled", ["PRAGMA foreign_keys=OFF"], "PRAGMA foreign_keys");

sequenceParity(
  "foreign_keys accepts ON and OFF",
  [],
  [
    { sql: "PRAGMA foreign_keys=ON" },
    { sql: "PRAGMA foreign_keys", query: true },
    { sql: "PRAGMA foreign_keys=OFF" },
    { sql: "PRAGMA foreign_keys", query: true },
  ],
);

sequenceParity(
  "foreign_keys accepts 1 and 0",
  [],
  [
    { sql: "PRAGMA foreign_keys=1" },
    { sql: "PRAGMA foreign_keys", query: true },
    { sql: "PRAGMA foreign_keys=0" },
    { sql: "PRAGMA foreign_keys", query: true },
  ],
);

parity("unknown pragma returns no rows", [], "PRAGMA sqlite_mem_unknown");
