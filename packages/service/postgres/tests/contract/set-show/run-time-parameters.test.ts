import { parity, queryErrorParity, sequenceParity } from "../helpers.ts";

// #678: the rest of PostgreSQL's run-time parameters, their checks and pg_settings

sequenceParity(
  "SET accepts the parameters ORMs, poolers and restore scripts send",
  [],
  [
    { sql: "SET session_replication_role = replica" },
    { sql: "SET work_mem = '8MB'" },
    { sql: "SET maintenance_work_mem = '64MB'" },
    { sql: "SET jit = off" },
    { sql: "SET synchronous_commit = off" },
    { sql: "SET enable_seqscan = off" },
    { sql: "SET random_page_cost = 1.1" },
    { sql: "SET plan_cache_mode = force_custom_plan" },
    { sql: "SET log_statement = 'none'" },
    { sql: "SET idle_session_timeout = 0" },
    { sql: "SET temp_buffers = '8MB'" },
    { sql: "SET max_parallel_workers_per_gather = 0" },
    { sql: "SET constraint_exclusion = partition" },
    { sql: "SHOW session_replication_role", query: true },
    { sql: "SHOW work_mem", query: true },
    { sql: "SHOW random_page_cost", query: true },
    { sql: "SHOW plan_cache_mode", query: true },
    { sql: "RESET ALL" },
  ],
);

sequenceParity(
  "SHOW prints the server's parameters in their largest whole unit",
  [],
  [
    { sql: "SHOW max_connections", query: true },
    { sql: "SHOW shared_buffers", query: true },
    { sql: "SHOW wal_level", query: true },
    { sql: "SHOW block_size", query: true },
    { sql: "SHOW ssl", query: true },
    { sql: "SHOW in_hot_standby", query: true },
    { sql: "SHOW default_text_search_config", query: true },
    { sql: "SHOW deadlock_timeout", query: true },
    { sql: "SHOW log_min_duration_statement", query: true },
    { sql: "SHOW track_activities", query: true },
    { sql: "SHOW transaction_deferrable", query: true },
    { sql: "SHOW effective_cache_size", query: true },
    { sql: "SHOW checkpoint_timeout", query: true },
    { sql: "SHOW log_rotation_age", query: true },
    { sql: "SHOW wal_segment_size", query: true },
    { sql: "SHOW wal_buffers", query: true },
    { sql: "SHOW autovacuum_work_mem", query: true },
    { sql: "SHOW autovacuum_vacuum_cost_delay", query: true },
  ],
);

sequenceParity(
  "integer and real parameters take units and print the canonical form",
  [],
  [
    { sql: "SET work_mem = 100000" },
    { sql: "SHOW work_mem", query: true },
    { sql: "SET work_mem = '1.5MB'" },
    { sql: "SHOW work_mem", query: true },
    { sql: "SET work_mem = '8 MB'" },
    { sql: "SELECT current_setting('work_mem') AS v", query: true },
    { sql: "SET work_mem = 0x100" },
    { sql: "SHOW work_mem", query: true },
    { sql: "SET statement_timeout = '1.5s'" },
    { sql: "SHOW statement_timeout", query: true },
    { sql: "SET statement_timeout = 90000" },
    { sql: "SHOW statement_timeout", query: true },
    { sql: "SET statement_timeout = '1h'" },
    { sql: "SHOW statement_timeout", query: true },
    { sql: "SET random_page_cost = '1e2'" },
    { sql: "SHOW random_page_cost", query: true },
    { sql: "SET vacuum_cost_delay = '1.5ms'" },
    { sql: "SHOW vacuum_cost_delay", query: true },
    { sql: "RESET ALL" },
  ],
);

sequenceParity(
  "Boolean and enum parameters take PostgreSQL's spellings",
  [],
  [
    { sql: "SET jit = 'TRUE'" },
    { sql: "SHOW jit", query: true },
    { sql: "SET jit = 'of'" },
    { sql: "SHOW jit", query: true },
    { sql: "SET synchronous_commit = true" },
    { sql: "SHOW synchronous_commit", query: true },
    { sql: "SET constraint_exclusion = yes" },
    { sql: "SHOW constraint_exclusion", query: true },
    { sql: "SET plan_cache_mode = 'FORCE_custom_plan'" },
    { sql: "SHOW plan_cache_mode", query: true },
    { sql: "RESET ALL" },
  ],
);

queryErrorParity("a value outside the parameter's range is 22023", [], "SET extra_float_digits = 10");
queryErrorParity("a non-number for an integer parameter is 22023", [], "SET work_mem = 'abc'");
queryErrorParity("a unit in the wrong case is 22023", [], "SET work_mem = '8 mb'");
queryErrorParity("a negative cost is out of range", [], "SET random_page_cost = -1");
queryErrorParity("an ambiguous Boolean is refused", [], "SET jit = 'o'");
queryErrorParity("an unknown enum value is refused", [], "SET plan_cache_mode = 'bad'");
queryErrorParity("an internal parameter cannot be changed", [], "SET block_size = 5");
queryErrorParity("server_version cannot be changed", [], "SET server_version = '1'");
queryErrorParity("a server-start parameter cannot be changed", [], "SET max_connections = 5");
queryErrorParity("a reload parameter cannot be changed by SET", [], "SET ssl = on");
queryErrorParity("a connection-start parameter cannot be changed by SET", [], "SET ignore_system_indexes = on");

parity(
  "pg_settings lists every parameter",
  [],
  "SELECT name FROM pg_settings WHERE name IN ('max_connections', 'server_version', 'TimeZone', 'work_mem') ORDER BY 1",
);

parity("pg_settings has the full list", [], "SELECT count(*) > 200 AS has_full_list FROM pg_settings");

sequenceParity(
  "pg_settings reports the setting in base units with its metadata",
  [],
  [
    { sql: "SET work_mem = '8MB'" },
    {
      sql: `SELECT name, setting, unit, category, short_desc, context, vartype, source, min_val, max_val, enumvals,
              boot_val, reset_val, pending_restart
            FROM pg_settings WHERE name IN ('jit', 'plan_cache_mode', 'random_page_cost',
              'application_name', 'session_replication_role', 'deadlock_timeout', 'block_size')
            ORDER BY name`,
      query: true,
    },
    // work_mem's maximum is 2097151 kB on PGlite's 32-bit build, so only its value is compared
    { sql: "SELECT setting, unit, source, reset_val FROM pg_settings WHERE name = 'work_mem'", query: true },
    { sql: "SELECT set_config('work_mem', '16MB', false) AS v", query: true },
    { sql: "SELECT set_config('work_mem', NULL, false) AS v", query: true },
    { sql: "SELECT setting, source FROM pg_settings WHERE name = 'work_mem'", query: true },
    { sql: "RESET ALL" },
  ],
);

sequenceParity(
  "SET ... TO DEFAULT and RESET return a parameter to its default",
  [],
  [
    { sql: "SET maintenance_work_mem = '1GB'" },
    { sql: "SET maintenance_work_mem TO DEFAULT" },
    { sql: "SHOW maintenance_work_mem", query: true },
    { sql: "SET enable_hashjoin = off" },
    { sql: "RESET enable_hashjoin" },
    { sql: "SHOW enable_hashjoin", query: true },
    { sql: "BEGIN" },
    { sql: "SET LOCAL work_mem = '1MB'" },
    { sql: "SHOW work_mem", query: true },
    { sql: "SET work_mem = '2MB'" },
    { sql: "SHOW work_mem", query: true },
    { sql: "COMMIT" },
    { sql: "SHOW work_mem", query: true },
    { sql: "RESET ALL" },
  ],
);

sequenceParity(
  "session_replication_role = replica skips triggers and foreign keys",
  [
    "CREATE TABLE srr_p (id int PRIMARY KEY)",
    "CREATE TABLE srr_c (pid int REFERENCES srr_p ON DELETE CASCADE, n int)",
    "CREATE TABLE srr_log (msg text)",
    "CREATE FUNCTION srr_tg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO srr_log VALUES (TG_OP); NEW.n := 42; RETURN NEW; END $$",
    "CREATE TRIGGER srr_b BEFORE INSERT ON srr_c FOR EACH ROW EXECUTE FUNCTION srr_tg()",
    "CREATE FUNCTION srr_stg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO srr_log VALUES ('stmt'); RETURN NULL; END $$",
    "CREATE TRIGGER srr_s AFTER INSERT ON srr_c FOR EACH STATEMENT EXECUTE FUNCTION srr_stg()",
  ],
  [
    { sql: "SET session_replication_role = replica" },
    { sql: "INSERT INTO srr_c VALUES (1, 1)" },
    { sql: "INSERT INTO srr_p VALUES (2)" },
    { sql: "INSERT INTO srr_c VALUES (2, 1)" },
    { sql: "DELETE FROM srr_p WHERE id = 2" },
    { sql: "SELECT pid, n FROM srr_c ORDER BY pid", query: true },
    { sql: "SELECT count(*)::int AS n FROM srr_log", query: true },
    { sql: "SET session_replication_role = origin" },
    { sql: "INSERT INTO srr_c VALUES (3, 1)" },
    { sql: "INSERT INTO srr_p VALUES (4)" },
    { sql: "INSERT INTO srr_c VALUES (4, 1)" },
    { sql: "SELECT pid, n FROM srr_c ORDER BY pid", query: true },
    { sql: "SELECT msg FROM srr_log ORDER BY msg", query: true },
  ],
);
