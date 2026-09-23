import { describe, expect, test } from "bun:test"
import { execute, parseSql, type Row, referencedColumns, SqlError } from "./src/index.js"

const rows: Row[] = [
  {
    _timestamp: Date.parse("2026-09-20T10:00:00Z") * 1000,
    event: "pg_pool_stats",
    service_name: "backend",
    waiting: 0,
  },
  {
    _timestamp: Date.parse("2026-09-20T11:00:00Z") * 1000,
    event: "pg_pool_saturated",
    service_name: "backend",
    waiting: 7,
  },
  {
    _timestamp: Date.parse("2026-09-20T12:00:00Z") * 1000,
    event: "pg_pool_error",
    service_name: "emr",
    waiting: 3,
    error: "ECONNRESET",
  },
]

const run = (sql: string) => execute(parseSql(sql), rows)

describe("the O2 SQL subset", () => {
  test("BETWEEN ISO strings on _timestamp (the incident runbook query), IN, ORDER BY ASC", () => {
    expect(
      run(`SELECT _timestamp, event FROM "default"
        WHERE service_name = 'backend'
          AND _timestamp BETWEEN '2026-09-20T09:30:00Z' AND '2026-09-20T11:30:00Z'
          AND event IN ('pg_pool_stats', 'pg_pool_saturated', 'pg_pool_error')
        ORDER BY _timestamp`).map((r) => r.event),
    ).toEqual(["pg_pool_stats", "pg_pool_saturated"])
  })

  test("NOT IN, LIKE, ILIKE, <>, comparisons and match_all", () => {
    expect(run(`SELECT event FROM "default" WHERE service_name NOT IN ('emr')`)).toHaveLength(2)
    expect(run(`SELECT event FROM "default" WHERE event LIKE 'pg_pool_s%'`)).toHaveLength(2)
    expect(run(`SELECT event FROM "default" WHERE event ILIKE 'PG_POOL_ERR%'`)).toHaveLength(1)
    expect(run(`SELECT event FROM "default" WHERE service_name <> 'backend'`)).toHaveLength(1)
    expect(run(`SELECT event FROM "default" WHERE waiting >= 3`).map((r) => r.event)).toEqual([
      "pg_pool_error",
      "pg_pool_saturated",
    ])
    expect(run(`SELECT event FROM "default" WHERE match_all('econnreset')`)).toHaveLength(1)
    expect(run(`SELECT event FROM "default" WHERE error IS NULL`)).toHaveLength(2)
  })

  test("GROUP BY with aggregates, HAVING and ORDER BY an alias", () => {
    expect(
      run(`SELECT service_name, count(*) AS n, max(waiting) AS worst, avg(waiting) AS mean
        FROM "default" GROUP BY service_name HAVING n > 1 ORDER BY n DESC`),
    ).toEqual([{ service_name: "backend", n: 2, worst: 7, mean: 3.5 }])
    expect(run(`SELECT COUNT(DISTINCT service_name) AS services FROM "default"`)).toEqual([
      { services: 2 },
    ])
  })

  test("LIMIT and OFFSET, default order newest first", () => {
    expect(run(`SELECT event FROM "default" LIMIT 2 OFFSET 1`).map((r) => r.event)).toEqual([
      "pg_pool_saturated",
      "pg_pool_stats",
    ])
  })

  test("column references exclude select aliases; syntax errors are SqlError", () => {
    expect(
      referencedColumns(
        parseSql(`SELECT code, count(*) AS n FROM "default" GROUP BY code ORDER BY n DESC`),
      ).sort(),
    ).toEqual(["code"])
    expect(() => parseSql("SELECT FROM")).toThrow(SqlError)
    expect(() => parseSql(`SELECT * FROM "default" WHERE nope(x)`)).toThrow("unsupported function")
    expect(() => parseSql(`SELECT * FROM "default" WHERE a = 'unterminated`)).toThrow(SqlError)
  })
})
