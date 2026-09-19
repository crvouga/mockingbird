import { expect, test } from "bun:test"
import fc from "fast-check"
import { fromFetchHandler, PostgresDatabase, SqliteDatabase, toFetchHandler } from "./src/index.js"

type Echo = { method: string; url: string; echoed: string }

const webUrl = fc.webUrl().filter((raw: string) => !raw.includes("#"))

const bodyfulStatus = fc
  .integer({ min: 200, max: 599 })
  .filter((status) => status !== 204 && status !== 205 && status !== 304)

test("facade toFetchHandler ∘ fromFetchHandler preserves responses", async () => {
  await fc.assert(
    fc.asyncProperty(
      webUrl,
      bodyfulStatus,
      fc.constantFrom("GET", "POST"),
      async (url, status, method) => {
        const init: RequestInit = { method }
        if (method === "POST") {
          init.body = "payload"
        }
        const handler = async (request: Request) => {
          const echoed = await request.text()
          return new Response(
            JSON.stringify({ method: request.method, url: request.url, echoed }),
            { status, headers: { "content-type": "application/json" } },
          )
        }
        const roundTripped = toFetchHandler(fromFetchHandler(handler))
        const response = await roundTripped(new Request(url, init))
        expect(response.status).toBe(status)
        const payload = (await response.json()) as Echo
        expect(payload.method).toBe(method)
        expect(payload.url).toBe(new Request(url, init).url)
        expect(payload.echoed).toBe(method === "POST" ? "payload" : "")
      },
    ),
  )
})

test("facade database aliases expose both in-memory engines", () => {
  const postgres = new PostgresDatabase()
  const sqlite = new SqliteDatabase()

  postgres.exec("CREATE TABLE values_table (value integer)")
  postgres.prepare("INSERT INTO values_table (value) VALUES ($1)").run(42)
  sqlite.exec("CREATE TABLE values_table (value integer)")
  sqlite.prepare("INSERT INTO values_table (value) VALUES (?)").run(42)

  expect(postgres.query("SELECT value FROM values_table")).toEqual([{ value: 42 }])
  expect(sqlite.query("SELECT value FROM values_table")).toEqual([{ value: 42 }])
})
