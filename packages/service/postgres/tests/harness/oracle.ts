import { PgliteAdapter } from "../adapters/pglite.ts";
import { PostgresServerAdapter } from "../adapters/postgres-server.ts";
import type { ContractDb } from "./types.ts";

export type OracleKind = "pglite" | "server";

/**
 * Select the differential oracle.
 *
 * - `POSTGRES_MEM_ORACLE=pglite` (default) — in-process PGlite (CI / day-to-day)
 * - `POSTGRES_MEM_ORACLE=server` — TCP PostgreSQL via `POSTGRES_MEM_ORACLE_URL`
 *   (started by `bun run test:postgres-native`, or an external Docker / local server)
 */
export function oracleKind(): OracleKind {
  const raw = (process.env.POSTGRES_MEM_ORACLE ?? "pglite").trim().toLowerCase();
  if (raw === "server" || raw === "postgres" || raw === "native") return "server";
  if (raw === "pglite" || raw === "" || raw === "default") return "pglite";
  throw new Error(`Unknown POSTGRES_MEM_ORACLE=${JSON.stringify(raw)} (expected "pglite" or "server")`);
}

export function createOracleAdapter(): ContractDb {
  return oracleKind() === "server" ? new PostgresServerAdapter() : new PgliteAdapter();
}
