import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Database, Engine, SQLModule } from "./types.ts"

export const root = join(import.meta.dir, "../..")

export async function engines(wasm: boolean, moduleDirectory?: string): Promise<Engine[]> {
  const results: Engine[] = []
  for (const name of ["sqlite", "postgres"]) {
    const url = pathToFileURL(
      moduleDirectory
        ? join(moduleDirectory, name, "index.js")
        : join(root, "packages/service", name, "src/index.ts"),
    ).href
    const module = (await import(url)) as SQLModule
    results.push({
      name,
      parameter: name === "postgres" ? "$1" : "?",
      module,
      create: () => new module.Database(),
    })
  }
  if (wasm) {
    const entry = Bun.resolveSync("sql.js", join(root, "packages/service/sqlite"))
    const init = (await import(entry)).default as (options: {
      locateFile(name: string): string
    }) => Promise<{
      Database: new () => {
        run(sql: string): void
        prepare(sql: string): {
          run(values: unknown[]): void
          reset(): void
          bind(values: unknown[]): void
          step(): boolean
          getAsObject(): unknown
          free(): void
        }
        close(): void
      }
    }>
    const SQL = await init({
      locateFile: (name) =>
        Bun.resolveSync(`sql.js/dist/${name}`, join(root, "packages/service/sqlite")),
    })
    results.push({
      name: "sql.js",
      parameter: "?",
      create() {
        const db = new SQL.Database()
        const statements: { free(): void }[] = []
        const prepare = (sql: string) => {
          const stmt = db.prepare(sql)
          statements.push(stmt)
          return {
            run: (...values: unknown[]) => {
              stmt.run(values)
            },
            get: <T>(...values: unknown[]): T | undefined => {
              stmt.reset()
              stmt.bind(values)
              const row = stmt.step() ? (stmt.getAsObject() as T) : undefined
              stmt.reset()
              return row
            },
          }
        }
        return {
          state: undefined,
          exec: (sql) => db.run(sql),
          prepare,
          query: <T>(sql: string): T[] => {
            const stmt = db.prepare(sql)
            const rows: T[] = []
            try {
              while (stmt.step()) rows.push(stmt.getAsObject() as T)
            } finally {
              stmt.free()
            }
            return rows
          },
          transaction: <T>(run: () => T): T => {
            db.run("BEGIN")
            try {
              const value = run()
              db.run("COMMIT")
              return value
            } catch (error) {
              db.run("ROLLBACK")
              throw error
            }
          },
          close: () => {
            for (const stmt of statements) stmt.free()
            db.close()
          },
        }
      },
    })
  }
  return results
}

export function seed(engine: Engine, count: number, db = engine.create()): Database {
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)")
  const insert = db.prepare(
    `INSERT INTO t VALUES (${engine.parameter}, ${engine.name === "postgres" ? "$2" : "?"})`,
  )
  db.transaction(() => {
    for (let i = 0; i < count; i++) insert.run(i, 0)
  })
  return db
}
