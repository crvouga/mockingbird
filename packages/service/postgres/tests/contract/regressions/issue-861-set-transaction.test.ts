import { describe } from "bun:test";
import { sequenceParity } from "../helpers.ts";

// #861: SET TRANSACTION as the first statement after BEGIN sets the level; only a SAVEPOINT the
// session made is a subtransaction that refuses it. The wire server's side is tests/wire/issue-861.test.ts.

describe("#861 SET TRANSACTION right after BEGIN", () => {
  sequenceParity(
    "SET TRANSACTION before the first query, and inside a SAVEPOINT",
    ["CREATE TABLE t861 (x int)"],
    [
      { sql: "BEGIN" },
      { sql: "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE" },
      { sql: "SHOW transaction_isolation", query: true },
      { sql: "SELECT 1 AS one", query: true },
      { sql: "COMMIT" },
      { sql: "BEGIN" },
      { sql: "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY, DEFERRABLE" },
      { sql: "SHOW transaction_isolation", query: true },
      { sql: "SHOW transaction_read_only", query: true },
      { sql: "SHOW transaction_deferrable", query: true },
      { sql: "COMMIT" },
      { sql: "BEGIN" },
      { sql: "SAVEPOINT s" },
      { sql: "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE" },
      { sql: "ROLLBACK" },
      { sql: "BEGIN" },
      { sql: "SAVEPOINT s" },
      { sql: "RELEASE SAVEPOINT s" },
      { sql: "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE" },
      { sql: "SHOW transaction_isolation", query: true },
      { sql: "COMMIT" },
    ],
  );
});
