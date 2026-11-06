import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"
import { createServer } from "./src/server.js"

type Account = { accountId: string; accountBalance: number | null; accountCBA: number | null }
type Invoice = { invoiceId: string; accountId: string; amount: number; status: string }

const harness = () => {
  const runtime = createRuntime({ username: "fixture-user", password: "fixture-password" })
  runtime.clock.freeze()
  runtime.clock.set(Date.parse("2026-10-04T12:00:00Z"))
  const send = (
    path: string,
    body?: unknown,
    tenant = "tenant-a",
    namespace: string | undefined = "default",
    method = body === undefined ? "GET" : "POST",
    auth = true,
  ) =>
    runtime.fetch(
      new Request(new URL(path, "http://kill-bill.test"), {
        method,
        headers: {
          "content-type": "application/json",
          "x-killbill-createdby": "fixture",
          "x-killbill-apikey": tenant,
          "x-killbill-apisecret": "fixture-secret",
          ...(namespace === undefined ? {} : { "x-mockingbird-namespace": namespace }),
          ...(auth ? { authorization: `Basic ${btoa("fixture-user:fixture-password")}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const seed = async (tenant = "tenant-a", count = 5, namespace = "default") => {
    expect(
      (
        await send(
          "/1.0/kb/tenants",
          { apiKey: tenant, apiSecret: "fixture-secret" },
          tenant,
          namespace,
        )
      ).status,
    ).toBe(201)
    const accounts: Account[] = []
    const invoices: Invoice[] = []
    for (let i = 0; i < count; i++) {
      const response = await send(
        "/1.0/kb/accounts",
        { externalKey: `${tenant}-${i}`, currency: "USD" },
        tenant,
        namespace,
      )
      expect(response.status).toBe(201)
      const account = (await (
        await send(response.headers.get("location") as string, undefined, tenant, namespace)
      ).json()) as Account
      accounts.push(account)
      const invoiceResponse = await send(
        `/1.0/kb/invoices/charges/${account.accountId}`,
        [{ amount: 20 + i, description: "Synthetic charge" }],
        tenant,
        namespace,
      )
      expect(invoiceResponse.status).toBe(201)
      invoices.push(
        (await (
          await send(
            invoiceResponse.headers.get("location") as string,
            undefined,
            tenant,
            namespace,
          )
        ).json()) as Invoice,
      )
      runtime.clock.advance(1000)
    }
    return { accounts, invoices }
  }
  return { runtime, send, seed }
}

describe("Kill Bill collection reconciliation", () => {
  test("accounts and invoices are restricted to the authenticated tenant and share billing state", async () => {
    const { send, seed } = harness()
    const first = await seed()
    const second = await seed("tenant-b", 2)
    for (const [tenant, fixtures] of [
      ["tenant-a", first],
      ["tenant-b", second],
    ] as const) {
      const accounts = await send("/1.0/kb/accounts/pagination", undefined, tenant)
      expect(accounts.status).toBe(200)
      const accountRows = (await accounts.json()) as Account[]
      expect(accountRows.map((row) => row.accountId)).toEqual(
        fixtures.accounts.map((row) => row.accountId),
      )
      expect(
        accountRows.every((row) => row.accountBalance === null && row.accountCBA === null),
      ).toBe(true)
      const invoices = await send("/1.0/kb/invoices/pagination", undefined, tenant)
      expect(invoices.status).toBe(200)
      // Kill Bill 0.24.16 pages invoices without their components: amounts zero, no items.
      expect(await invoices.json()).toEqual(
        fixtures.invoices.map((row) => ({
          ...row,
          amount: 0,
          balance: 0,
          creditAdj: 0,
          refundAdj: 0,
          items: [],
        })),
      )
      expect(accounts.headers.get("x-killbill-pagination-totalnbrecords")).toBe(
        String(fixtures.accounts.length),
      )
    }
    const balances = await send("/1.0/kb/accounts/pagination?accountWithBalance=true")
    expect(((await balances.json()) as Account[]).map((row) => row.accountBalance)).toEqual([
      20, 21, 22, 23, 24,
    ])
    const both = await send("/1.0/kb/accounts/pagination?accountWithBalanceAndCBA=true")
    expect(
      ((await both.json()) as Account[]).every(
        (row) => row.accountCBA === 0 && row.accountBalance !== null,
      ),
    ).toBe(true)
  })

  test("following offsets reaches every ID once, including reverse order and live invoice updates", async () => {
    const { send, seed } = harness()
    const fixtures = await seed()
    await send(
      `/1.0/kb/invoices/${fixtures.invoices[0]?.invoiceId}/voidInvoice`,
      {},
      "tenant-a",
      "default",
      "PUT",
    )
    for (const resource of ["accounts", "invoices"] as const) {
      for (const limit of [2, -2]) {
        let offset = 0
        const ids: string[] = []
        for (let page = 0; page < 4; page++) {
          const response = await send(
            `/1.0/kb/${resource}/pagination?offset=${offset}&limit=${limit}`,
          )
          expect(response.status).toBe(200)
          expect(response.headers.get("x-killbill-pagination-currentoffset")).toBe(String(offset))
          expect(response.headers.get("x-killbill-pagination-maxnbrecords")).toBe("5")
          const rows = (await response.json()) as (Account & Invoice)[]
          ids.push(...rows.map((row) => (resource === "accounts" ? row.accountId : row.invoiceId)))
          const next = response.headers.get("x-killbill-pagination-nextoffset")
          if (next === null) {
            expect(response.headers.get("x-killbill-pagination-nextpageuri")).toBeNull()
            break
          }
          expect(Number(next)).toBeGreaterThan(offset)
          expect(
            new URL(
              response.headers.get("x-killbill-pagination-nextpageuri") as string,
            ).searchParams.get("limit"),
          ).toBe(String(limit))
          offset = Number(next)
        }
        const expected =
          resource === "accounts"
            ? fixtures.accounts.map((row) => row.accountId)
            : fixtures.invoices.map((row) => row.invoiceId)
        expect(ids).toEqual(limit > 0 ? expected : expected.reverse())
        expect(new Set(ids).size).toBe(5)
      }
    }
    expect(
      ((await (await send("/1.0/kb/invoices/pagination")).json()) as Invoice[])[0]?.status,
    ).toBe("VOID")
  })

  test("empty and exhausted pages are bare arrays with terminal headers", async () => {
    const { send, seed } = harness()
    await seed("tenant-a", 0)
    for (const resource of ["accounts", "invoices"]) {
      const empty = await send(`/1.0/kb/${resource}/pagination`)
      expect(empty.status).toBe(200)
      expect(await empty.json()).toEqual([])
      expect(empty.headers.get("x-killbill-pagination-currentoffset")).toBe("0")
      expect(empty.headers.get("x-killbill-pagination-totalnbrecords")).toBe("0")
      expect(empty.headers.get("x-killbill-pagination-maxnbrecords")).toBe("0")
      expect(empty.headers.get("x-killbill-pagination-nextoffset")).toBeNull()
      expect(empty.headers.get("x-killbill-pagination-nextpageuri")).toBeNull()
    }
    await seed("tenant-b", 2)
    for (const resource of ["accounts", "invoices"]) {
      const exhausted = await send(
        `/1.0/kb/${resource}/pagination?offset=100`,
        undefined,
        "tenant-b",
      )
      expect(exhausted.status).toBe(200)
      expect(await exhausted.json()).toEqual([])
      expect(exhausted.headers.get("x-killbill-pagination-currentoffset")).toBe("100")
      expect(exhausted.headers.get("x-killbill-pagination-totalnbrecords")).toBe("2")
      expect(exhausted.headers.get("x-killbill-pagination-nextoffset")).toBeNull()
    }
  })

  test("namespace URLs, snapshot restore, reset, auth and HTTP faults retain tenant isolation", async () => {
    const { runtime, send, seed } = harness()
    await seed("tenant-a", 2, "other")
    await seed("tenant-a", 0)
    const page = await send("/1.0/kb/accounts/pagination?limit=1", undefined, "tenant-a", "other")
    const next = page.headers.get("x-killbill-pagination-nextpageuri") as string
    expect(new URL(next).pathname).toBe("/__admin/ns/other/1.0/kb/accounts/pagination")
    const followed = await runtime.fetch(
      new Request(next, {
        headers: {
          authorization: `Basic ${btoa("fixture-user:fixture-password")}`,
          "x-killbill-apikey": "tenant-a",
          "x-killbill-apisecret": "fixture-secret",
        },
      }),
    )
    expect(followed.status).toBe(200)
    expect(await followed.json()).toHaveLength(1)
    const path = "/1.0/kb/accounts/pagination"
    expect((await send(path, undefined, "tenant-a", "other", "GET", false)).status).toBe(401)
    expect((await send(path, undefined, "unknown", "other")).status).toBe(401)
    const snapshotResponse = await send("/__admin/snapshots", {}, "tenant-a", "other")
    expect(snapshotResponse.status).toBe(201)
    const snapshot = (await snapshotResponse.json()) as { id: string }
    await send("/1.0/kb/accounts", { externalKey: "later", currency: "USD" }, "tenant-a", "other")
    await send(`/__admin/snapshots/${snapshot.id}/restore`, {}, "tenant-a", "other")
    expect(await (await send(path, undefined, "tenant-a", "other")).json()).toHaveLength(2)
    runtime.applyPreset("rate_limited", "other", { count: 1 })
    expect((await send(path, undefined, "tenant-a", "other")).status).toBe(429)
    expect(
      (
        await send(
          "/__admin/faults",
          { status: 500, body: { message: "Synthetic failure" }, count: 1 },
          "tenant-a",
          "other",
        )
      ).status,
    ).toBe(201)
    expect((await send(path, undefined, "tenant-a", "other")).status).toBe(500)
    expect(await (await send(path, undefined, "tenant-a", "other")).json()).toHaveLength(2)
    expect((await send(`${path}?limit=invalid`, undefined, "tenant-a", "other")).status).toBe(400)
    const zero = await send(`${path}?limit=0`, undefined, "tenant-a", "other")
    expect(zero.status).toBe(200)
    expect(await zero.json()).toEqual([])
    await send("/__admin/reset", {}, "tenant-a", "other")
    expect((await send(path, undefined, "tenant-a", "other")).status).toBe(401)
    await seed("tenant-a", 0, "other")
    expect(await (await send(path, undefined, "tenant-a", "other")).json()).toEqual([])
  })

  test("the raw HTTP client can follow a custom-prefix namespace next-page URL", async () => {
    const server = await createServer({
      adminPrefix: "/_control",
      username: "fixture-user",
      password: "fixture-password",
      tenantKey: "fixture-tenant",
      tenantSecret: "fixture-secret",
    })
    const headers = {
      authorization: `Basic ${btoa("fixture-user:fixture-password")}`,
      "x-killbill-apikey": "fixture-tenant",
      "x-killbill-apisecret": "fixture-secret",
      "x-killbill-createdby": "fixture",
      "content-type": "application/json",
    }
    try {
      const base = `${server.url}/_control/ns/served/1.0/kb`
      for (let i = 0; i < 2; i++)
        expect(
          (
            await fetch(`${base}/accounts`, {
              method: "POST",
              headers,
              body: JSON.stringify({ currency: "USD", externalKey: `served-${i}` }),
            })
          ).status,
        ).toBe(201)
      const first = await fetch(`${base}/accounts/pagination?limit=1`, { headers })
      expect(first.status).toBe(200)
      const next = first.headers.get("x-killbill-pagination-nextpageuri") as string
      expect(new URL(next).pathname).toBe("/_control/ns/served/1.0/kb/accounts/pagination")
      const second = await fetch(next, { headers })
      expect(second.status).toBe(200)
      expect(await second.json()).toHaveLength(1)
      expect(second.headers.get("x-killbill-pagination-nextoffset")).toBeNull()
    } finally {
      await server.close()
    }
  })
})
