import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "ROLLBACK TO a missing savepoint fails with 3B001",
  [],
  [{ sql: "BEGIN" }, { sql: "ROLLBACK TO SAVEPOINT nosuch" }, { sql: "ROLLBACK" }],
);

sequenceParity(
  "RELEASE a missing savepoint fails with 3B001",
  [],
  [{ sql: "BEGIN" }, { sql: "RELEASE SAVEPOINT nosuch" }, { sql: "ROLLBACK" }],
);

sequenceParity("SAVEPOINT outside a transaction fails", [], [{ sql: "SAVEPOINT sp1" }]);

sequenceParity(
  "released savepoint can no longer be rolled back to",
  [],
  [{ sql: "BEGIN" }, { sql: "SAVEPOINT sp" }, { sql: "RELEASE sp" }, { sql: "ROLLBACK TO sp" }, { sql: "ROLLBACK" }],
);

sequenceParity(
  "releasing an outer savepoint removes inner savepoints too",
  [],
  [
    { sql: "BEGIN" },
    { sql: "SAVEPOINT a" },
    { sql: "SAVEPOINT b" },
    { sql: "RELEASE a" },
    { sql: "ROLLBACK TO b" },
    { sql: "ROLLBACK" },
  ],
);

sequenceParity(
  "rollback-to an inner savepoint removes savepoints created after it",
  [],
  [
    { sql: "BEGIN" },
    { sql: "SAVEPOINT a" },
    { sql: "SAVEPOINT b" },
    { sql: "ROLLBACK TO a" },
    { sql: "ROLLBACK TO b" },
    { sql: "ROLLBACK" },
  ],
);
