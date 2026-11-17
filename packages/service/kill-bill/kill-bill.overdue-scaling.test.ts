/**
 * Kill Bill re-evaluates every account's overdue state after each request. That evaluation reads
 * the invoices once per request, not once per account, so a request on a namespace with many
 * accounts does not read accounts × invoices records.
 */
import { expect, test } from "bun:test"
import { Database } from "@crvouga/mockingbird-service-sqlite"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { createRuntime } from "./src/index.js"

const headers = {
  authorization: `Basic ${btoa("admin:password")}`,
  "content-type": "application/json",
  "x-killbill-apikey": "bob",
  "x-killbill-apisecret": "lazar",
  "x-killbill-createdby": "overdue-scaling-test",
}

/** A client that counts the stored records its statements return. */
const counting = () => {
  const db = new Database()
  let rowsRead = 0
  const client: SqliteClient = {
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction(fn),
    prepare: (sql) => {
      const statement = db.prepare(sql)
      const reads = sql.includes("FROM mockingbird_records")
      return {
        run: (...params) => statement.run(...params),
        get: (...params) => {
          const row = statement.get(...params)
          if (reads && row !== undefined) rowsRead++
          return row as never
        },
        all: (...params) => {
          const rows = statement.all(...params)
          if (reads) rowsRead += rows.length
          return rows as never
        },
      }
    },
  }
  return { client, rowsRead: () => rowsRead }
}

/** Stored records one GET reads once the namespace holds `accounts` billed accounts. */
const readsForOneRequest = async (accounts: number) => {
  const { client, rowsRead } = counting()
  const runtime = createRuntime({ sqlite: client, checkpointMutations: false })
  const call = (path: string, init: RequestInit = {}) =>
    runtime.fetch(new Request(`http://kill-bill.test/1.0/kb${path}`, { headers, ...init }))
  for (let n = 0; n < accounts; n++) {
    const created = await call("/accounts", {
      method: "POST",
      body: JSON.stringify({ externalKey: `account-${n}`, currency: "USD" }),
    })
    const accountId = created.headers.get("location")?.split("/").at(-1)
    await call("/subscriptions", {
      method: "POST",
      body: JSON.stringify({ accountId, planName: "standard-monthly" }),
    })
  }
  const start = rowsRead()
  expect((await call("/accounts?externalKey=account-0")).status).toBe(200)
  return rowsRead() - start
}

test("one request reads the invoices once, however many accounts hold them", async () => {
  const few = await readsForOneRequest(10)
  const many = await readsForOneRequest(40)
  expect(many).toBeLessThan(few * 6)
})
