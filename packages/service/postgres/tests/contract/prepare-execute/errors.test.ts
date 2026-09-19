import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "EXECUTE with too few arguments fails",
  [],
  [{ sql: "PREPARE p (int, int) AS SELECT $1 + $2" }, { sql: "EXECUTE p(1)", query: true }],
);

sequenceParity(
  "EXECUTE with too many arguments fails",
  [],
  [{ sql: "PREPARE p (int) AS SELECT $1" }, { sql: "EXECUTE p(1, 2)", query: true }],
);

sequenceParity(
  "duplicate prepared statement name fails with 42P05",
  [],
  [{ sql: "PREPARE p AS SELECT 1" }, { sql: "PREPARE p AS SELECT 2" }],
);

sequenceParity(
  "duplicate name fails even with an identical definition",
  [],
  [{ sql: "PREPARE p AS SELECT 1" }, { sql: "PREPARE p AS SELECT 1" }],
);

sequenceParity(
  "EXECUTE of an unknown prepared statement fails",
  [],
  [{ sql: "EXECUTE no_such_prepared", query: true }],
);

sequenceParity("DEALLOCATE of an unknown prepared statement fails", [], [{ sql: "DEALLOCATE no_such_prepared" }]);

sequenceParity(
  "EXECUTE with an argument that cannot be converted fails with 22P02",
  [],
  [{ sql: "PREPARE p (int) AS SELECT $1 + 1" }, { sql: "EXECUTE p('abc')", query: true }],
);

sequenceParity(
  "name is reusable after the failed duplicate PREPARE is deallocated",
  [],
  [
    { sql: "PREPARE p AS SELECT 1 AS v" },
    { sql: "PREPARE p AS SELECT 2 AS v" },
    { sql: "DEALLOCATE p" },
    { sql: "PREPARE p AS SELECT 3 AS v" },
    { sql: "EXECUTE p", query: true },
  ],
);
