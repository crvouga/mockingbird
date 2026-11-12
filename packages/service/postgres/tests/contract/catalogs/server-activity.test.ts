import { parity } from "../helpers.ts";

// #690: server-activity functions an in-process engine (one backend) can answer honestly

parity(
  "pg_blocking_pids of the only backend is empty",
  [],
  "SELECT cardinality(pg_blocking_pids(pg_backend_pid())) AS blockers",
);
parity(
  "signalling an unknown pid is false",
  [],
  "SELECT pg_cancel_backend(999999) AS cancelled, pg_terminate_backend(999999) AS terminated",
);
parity("pg_current_wal_lsn is present", [], "SELECT pg_current_wal_lsn() IS NOT NULL AS has_lsn");
parity(
  "NULL in, NULL out",
  [],
  "SELECT pg_blocking_pids(NULL) AS b, pg_cancel_backend(NULL) AS c, pg_terminate_backend(NULL) AS t",
);
parity(
  "pool-health query over pg_stat_activity",
  [],
  `SELECT count(*) FILTER (WHERE backend_type = 'client backend' AND cardinality(pg_blocking_pids(pid)) > 0)::int AS blocked
   FROM pg_stat_activity WHERE datname = current_database()`,
);
// pg_cancel_backend(pg_backend_pid()) is 57014 on a server (tests/wire/server-activity.test.ts);
// PGlite has no signals and answers false, so it is not compared here
