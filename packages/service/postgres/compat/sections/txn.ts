import { type CatalogSection, section } from "../scenario-types.ts";

const D = "documented_divergence" as const;

export const TXN_SECTION: CatalogSection = section("TXN", "Transactions and savepoints", true, [
  ["commit-01", "committed insert visible after COMMIT"],
  ["commit-02", "changes visible inside the txn before commit"],
  ["commit-03", "sequential transactions accumulate committed work"],
  ["rollback-01", "ROLLBACK discards inserts"],
  ["rollback-02", "ROLLBACK discards updates"],
  ["rollback-03", "ROLLBACK discards deletes"],
  ["ddl-01", "CREATE TABLE rolled back"],
  ["ddl-02", "CREATE TABLE committed"],
  ["ddl-03", "DROP TABLE rolled back restores table and data"],
  ["ddl-04", "CREATE TABLE plus INSERT rolled back together"],
  ["sp-01", "ROLLBACK TO undoes work after the savepoint only"],
  ["sp-02", "RELEASE SAVEPOINT keeps later changes"],
  ["sp-03", "nested savepoints: rollback to outer discards inner work"],
  ["sp-04", "nested savepoints: rollback to inner keeps outer work"],
  ["sp-05", "savepoint name reuse shadows the older savepoint"],
  ["sp-06", "work continues normally after ROLLBACK TO"],
  ["rec-01", "savepoint recovers a unique violation"],
  ["rec-02", "savepoint recovers division by zero"],
  ["edge-01", "COMMIT outside a transaction is tolerated"],
  ["edge-02", "ROLLBACK outside a transaction is tolerated"],
  ["edge-03", "nested BEGIN keeps a single transaction"],
  ["edge-04", "SAVEPOINT outside a transaction fails"],
  ["edge-05", "ROLLBACK works after a failed statement in a txn"],
  ["forms-01", "START TRANSACTION and END forms"],
  ["forms-02", "BEGIN WORK and COMMIT WORK forms"],
  [
    "abort-01",
    "aborted-transaction state (25P02) is not implemented",
    D,
    "memory keeps executing statements after a failure inside BEGIN; PostgreSQL rejects them with 25P02",
    ["tests/contract/_reports/session-system.md"],
    "no-aborted-transaction-state",
  ],
]);
