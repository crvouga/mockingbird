import { GUC_SECTION } from "../../../compat/sections/guc.ts";
import { runCatalog } from "./run.ts";

runCatalog(GUC_SECTION, [
  {
    id: "GUC-set-01",
    kind: "sequence",
    steps: [{ sql: "SET application_name = 'my_app'" }, { sql: "SHOW application_name", query: true }],
  },
  {
    id: "GUC-set-02",
    kind: "sequence",
    steps: [{ sql: "SET application_name TO 'to_form'" }, { sql: "SHOW application_name", query: true }],
  },
  {
    id: "GUC-set-03",
    kind: "sequence",
    steps: [
      { sql: "SET application_name = 'first'" },
      { sql: "SET application_name = 'second'" },
      { sql: "SHOW application_name", query: true },
    ],
  },
  {
    id: "GUC-reset-01",
    kind: "sequence",
    steps: [
      { sql: "SET application_name = 'temp_name'" },
      { sql: "RESET application_name" },
      { sql: "SHOW application_name", query: true },
    ],
  },
  {
    id: "GUC-reset-02",
    kind: "sequence",
    steps: [
      { sql: "SET application_name = 'temp_name'" },
      { sql: "SET application_name TO DEFAULT" },
      { sql: "SHOW application_name", query: true },
    ],
  },
  {
    id: "GUC-reset-03",
    kind: "sequence",
    steps: [
      { sql: "SET application_name = 'zzz'" },
      { sql: "RESET ALL" },
      { sql: "SHOW application_name", query: true },
    ],
  },
  {
    id: "GUC-local-01",
    kind: "sequence",
    steps: [
      { sql: "SET application_name = 'outer'" },
      { sql: "BEGIN" },
      { sql: "SET LOCAL application_name = 'inner'" },
      { sql: "SHOW application_name", query: true },
      { sql: "COMMIT" },
      { sql: "SHOW application_name", query: true },
    ],
  },
  {
    id: "GUC-local-02",
    kind: "sequence",
    steps: [
      { sql: "SET application_name = 'outer'" },
      { sql: "BEGIN" },
      { sql: "SET LOCAL application_name = 'inner'" },
      { sql: "SHOW application_name", query: true },
      { sql: "ROLLBACK" },
      { sql: "SHOW application_name", query: true },
    ],
  },
  {
    id: "GUC-local-03",
    kind: "sequence",
    steps: [
      { sql: "SET application_name = 'base'" },
      { sql: "SET LOCAL application_name = 'ephemeral'" },
      { sql: "SHOW application_name", query: true },
    ],
  },
  {
    id: "GUC-txn-01",
    kind: "sequence",
    steps: [
      { sql: "SET application_name = 'outer'" },
      { sql: "BEGIN" },
      { sql: "SET application_name = 'inner'" },
      { sql: "ROLLBACK" },
      { sql: "SHOW application_name", query: true },
    ],
  },
  {
    id: "GUC-txn-02",
    kind: "sequence",
    steps: [
      { sql: "BEGIN" },
      { sql: "SET application_name = 'txn_value'" },
      { sql: "COMMIT" },
      { sql: "SHOW application_name", query: true },
    ],
  },
  {
    id: "GUC-fn-01",
    kind: "sequence",
    steps: [
      { sql: "SELECT set_config('application_name', 'via_fn', false) AS v", query: true },
      { sql: "SHOW application_name", query: true },
      { sql: "SELECT current_setting('application_name') AS v", query: true },
    ],
  },
  {
    id: "GUC-fn-02",
    kind: "sequence",
    steps: [
      { sql: "SET application_name = 'from_set'" },
      { sql: "SELECT current_setting('application_name') AS v", query: true },
    ],
  },
  { id: "GUC-fn-03", kind: "parity", sql: "SELECT current_setting('no.such.setting', true) AS v" },
  { id: "GUC-fn-04", kind: "parity", sql: "SELECT current_setting('application_name', false) IS NOT NULL AS present" },
  {
    id: "GUC-custom-01",
    kind: "sequence",
    steps: [
      { sql: "SELECT set_config('myapp.tenant', 'acme', false) AS v", query: true },
      { sql: "SELECT current_setting('myapp.tenant') AS v", query: true },
    ],
  },
  {
    id: "GUC-custom-02",
    kind: "sequence",
    steps: [
      { sql: "SELECT current_setting('myapp.flag', true) AS v", query: true },
      { sql: "SELECT set_config('myapp.flag', 'on', false) AS v", query: true },
      { sql: "SELECT current_setting('myapp.flag', true) AS v", query: true },
    ],
  },
  {
    id: "GUC-path-01",
    kind: "sequence",
    setup: ["CREATE SCHEMA cfg"],
    steps: [
      { sql: "SET search_path TO cfg, public" },
      { sql: "SELECT current_setting('search_path') AS v", query: true },
    ],
  },
  {
    id: "GUC-tz-01",
    kind: "sequence",
    steps: [
      { sql: "SET timezone = 'UTC'" },
      { sql: "SELECT TIMESTAMPTZ '2020-01-01 12:00:00+00' AS v", query: true },
      { sql: "SET timezone = 'America/New_York'" },
      { sql: "SELECT TIMESTAMPTZ '2020-01-01 12:00:00+00' AS v", query: true },
    ],
  },
  {
    id: "GUC-tz-02",
    kind: "sequence",
    steps: [{ sql: "SET timezone = 'America/Chicago'" }, { sql: "SHOW timezone", query: true }],
  },
  { id: "GUC-ver-01", kind: "sequence", steps: [{ sql: "SHOW server_version", query: true }] },
  {
    id: "GUC-err-01",
    kind: "error",
    sql: "SELECT current_setting('no.such.thing')",
    query: true,
    messageTier: "A",
  },
  { id: "GUC-err-02", kind: "error", sql: "SHOW nonexistent_gucname", query: true, messageTier: "A" },
]);
