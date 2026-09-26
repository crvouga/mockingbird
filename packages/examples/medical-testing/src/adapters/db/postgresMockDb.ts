import { type BindValue, Database } from "@crvouga/mockingbird-service-postgres"
import type { Db } from "../../app/ports/db.js"

/**
 * The `Db` port, backed by Mockingbird's in-process, in-memory
 * Postgres-dialect engine. `Database.query` is synchronous — this wraps it
 * so the port's contract (real promises, like any Node pg client) holds
 * regardless of what's actually running underneath.
 */
export const createPostgresMockDb = (): Db => {
  const database = new Database({ now: "system" })
  return {
    query: async <T>(sql: string, params: readonly unknown[] = []) =>
      database.query<T>(sql, params as BindValue[]),
  }
}
