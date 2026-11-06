import { describe, expect, test } from "bun:test"
import { createServer } from "./src/server.js"

const headers = {
  authorization: `Basic ${btoa("admin:password")}`,
  "content-type": "application/json",
  "x-killbill-apikey": "bob",
  "x-killbill-apisecret": "lazar",
  "x-killbill-createdby": "acceptance-test",
}

type RecurringItem = {
  subscriptionId?: string
  itemType: string
  amount: number
  currency: string
}

describe("Kill Bill subscription price overrides", () => {
  const session = async () => {
    const server = await createServer()
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}/1.0/kb${path}`, { ...init, headers: { ...headers, ...init.headers } })
    const json = async <T>(path: string, init?: RequestInit) =>
      (await (await request(path, init)).json()) as T
    const created = await request("/accounts", {
      method: "POST",
      body: JSON.stringify({ currency: "USD" }),
    })
    const accountId = created.headers.get("location")?.split("/").at(-1) as string
    expect(
      (
        await request("/catalog", {
          method: "POST",
          body: JSON.stringify({
            plans: [{ name: "example-monthly", amount: 10, currency: "USD" }],
          }),
        })
      ).status,
    ).toBe(201)
    const subscriptionIds = async () => {
      const bundles = await json<Array<{ subscriptions: Array<{ subscriptionId: string }> }>>(
        `/accounts/${accountId}/bundles`,
      )
      return bundles.flatMap((bundle) => bundle.subscriptions.map((entry) => entry.subscriptionId))
    }
    const recurring = async (subscriptionId: string) => {
      const invoices = await json<Array<{ items: RecurringItem[] }>>(
        `/accounts/${accountId}/invoices?includeInvoiceComponents=true`,
      )
      return invoices
        .flatMap((invoice) => invoice.items)
        .filter((item) => item.subscriptionId === subscriptionId && item.itemType === "RECURRING")
    }
    return { server, request, json, accountId, subscriptionIds, recurring }
  }

  test("an evergreen priceOverrides recurringPrice is the invoice item amount", async () => {
    const { server, request, accountId, subscriptionIds, recurring } = await session()
    try {
      const before = await subscriptionIds()
      const created = await request("/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          accountId,
          planName: "example-monthly",
          priceOverrides: [{ phaseName: "example-monthly-evergreen", recurringPrice: 4 }],
        }),
      })
      expect(created.status).toBe(201)
      const subscriptionId = (await subscriptionIds()).find((id) => !before.includes(id)) as string
      expect(await recurring(subscriptionId)).toMatchObject([{ amount: 4, currency: "USD" }])
    } finally {
      await server.close()
    }
  })

  test("a subscription without priceOverrides invoices the catalog amount", async () => {
    const { server, request, accountId, subscriptionIds, recurring } = await session()
    try {
      const before = await subscriptionIds()
      const created = await request("/subscriptions", {
        method: "POST",
        body: JSON.stringify({ accountId, planName: "example-monthly" }),
      })
      expect(created.status).toBe(201)
      const subscriptionId = (await subscriptionIds()).find((id) => !before.includes(id)) as string
      expect(await recurring(subscriptionId)).toMatchObject([{ amount: 10, currency: "USD" }])
    } finally {
      await server.close()
    }
  })

  test("GET subscription returns the priceOverrides that were sent", async () => {
    const { server, request, json, accountId, subscriptionIds } = await session()
    try {
      const overrides = [{ phaseName: "example-monthly-evergreen", recurringPrice: 4 }]
      const before = await subscriptionIds()
      const created = await request("/subscriptions", {
        method: "POST",
        body: JSON.stringify({ accountId, planName: "example-monthly", priceOverrides: overrides }),
      })
      const subscriptionId = (await subscriptionIds()).find((id) => !before.includes(id)) as string
      expect(created.status).toBe(201)
      expect(
        await json<{ priceOverrides: unknown[] }>(`/subscriptions/${subscriptionId}`),
      ).toMatchObject({
        priceOverrides: overrides,
      })
    } finally {
      await server.close()
    }
  })

  test("an add-on created with requestedDate invoices its own evergreen override", async () => {
    const { server, request, accountId, subscriptionIds, recurring } = await session()
    try {
      const base = await request("/subscriptions", {
        method: "POST",
        body: JSON.stringify({ accountId, planName: "example-monthly" }),
      })
      const bundleId = base.headers.get("location")?.split("/").at(-1) as string
      const baseId = (await subscriptionIds()).at(-1) as string
      const requestedDate = new Date().toISOString().slice(0, 10)
      const before = await subscriptionIds()
      const addon = await request(`/subscriptions?requestedDate=${requestedDate}`, {
        method: "POST",
        body: JSON.stringify({
          accountId,
          bundleId,
          planName: "example-monthly",
          priceOverrides: [{ phaseName: "example-monthly-evergreen", recurringPrice: 4 }],
        }),
      })
      expect(addon.status).toBe(201)
      const addonId = (await subscriptionIds()).find((id) => !before.includes(id)) as string
      expect(addonId).not.toBe(baseId)
      expect(await recurring(baseId)).toMatchObject([{ amount: 10, currency: "USD" }])
      expect(await recurring(addonId)).toMatchObject([{ amount: 4, currency: "USD" }])
    } finally {
      await server.close()
    }
  })
})
