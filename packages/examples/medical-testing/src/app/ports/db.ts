/**
 * The only thing application code knows about persistence: an async,
 * promise-based SQL client, shaped like every real Node Postgres driver
 * (`pg`'s `pool.query(text, params)`, `postgres.js`, etc.) — not the
 * synchronous engine underneath any particular adapter.
 */
export interface Db {
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<T[]>
}
