import { describe, expect, test } from "bun:test"
import { createServer } from "./src/server.js"

// Behaviour captured from Kill Bill 0.24.16 (Geviti's production version) by scripts/parity.ts on
// 2026-11-06. These pin it without a live Kill Bill; the parity scenarios re-check it against one.

const headers = {
  authorization: `Basic ${btoa("admin:password")}`,
  "content-type": "application/json",
  "x-killbill-apikey": "bob",
  "x-killbill-apisecret": "lazar",
  "x-killbill-createdby": "kb-0.24.16-test",
}

async function session() {
  const server = await createServer({
    plans: [{ name: "monthly-100", amount: 100, currency: "USD", intervalDays: 30 }],
  })
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${server.url}/1.0/kb${path}`, {
      method,
      headers: { ...headers, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const json = async (path: string) => (await request(path)).json()
  await request("/test/clock?requestedDate=2030-01-01", "POST")
  const accountId = (await request("/accounts", "POST", { currency: "USD" })).headers
    .get("location")
    ?.split("/")
    .at(-1) as string
  await request(`/accounts/${accountId}/paymentMethods?isDefault=true`, "POST", {
    pluginName: "__EXTERNAL_PAYMENT__",
  })
  const subscribe = async () =>
    (await request("/subscriptions", "POST", { accountId, planName: "monthly-100" })).headers
      .get("location")
      ?.split("/")
      .at(-1) as string
  const account = () => json(`/accounts/${accountId}?accountWithBalanceAndCBA=true`)
  const invoices = () => json(`/accounts/${accountId}/invoices?includeInvoiceComponents=true`)
  return { server, request, json, accountId, subscribe, account, invoices }
}

describe("Kill Bill 0.24.16 behaviour", () => {
  test("a credit answers its CREDIT_ADJ item, becomes account credit, and the next invoice uses it", async () => {
    const s = await session()
    try {
      const credited = await s.request("/credits?autoCommit=true", "POST", [
        { accountId: s.accountId, amount: 40, currency: "USD", description: "goodwill" },
      ])
      expect(credited.status).toBe(200)
      expect(await credited.json()).toEqual([
        expect.objectContaining({ itemType: "CREDIT_ADJ", amount: 40, description: "goodwill" }),
      ])
      expect(await s.account()).toMatchObject({ accountBalance: -40, accountCBA: 40 })
      await s.subscribe()
      expect(await s.account()).toMatchObject({ accountBalance: 0, accountCBA: 0 })
      const renewal = (await s.invoices()).at(-1)
      expect(renewal).toMatchObject({ amount: 100, creditAdj: -40 })
      expect(
        renewal.items.map((item: { itemType: string; amount: number }) => [
          item.itemType,
          item.amount,
        ]),
      ).toEqual([
        ["RECURRING", 100],
        ["CBA_ADJ", -40],
      ])
    } finally {
      await s.server.close()
    }
  })

  test("an end-of-term cancel keeps the subscription active until the period ends and bills nothing after", async () => {
    const s = await session()
    try {
      const id = await s.subscribe()
      await s.request(
        `/subscriptions/${id}?entitlementPolicy=END_OF_TERM&billingPolicy=END_OF_TERM`,
        "DELETE",
      )
      const cancelled = await s.json(`/subscriptions/${id}`)
      expect(cancelled.state).toBe("ACTIVE")
      expect(cancelled.events.map((event: { eventType: string }) => event.eventType)).toEqual([
        "START_ENTITLEMENT",
        "START_BILLING",
        "STOP_ENTITLEMENT",
        "STOP_BILLING",
      ])
      await s.request("/test/clock?requestedDate=2030-02-01", "POST")
      expect((await s.json(`/subscriptions/${id}`)).state).toBe("CANCELLED")
      expect(await s.invoices()).toHaveLength(1)
    } finally {
      await s.server.close()
    }
  })

  test("an immediate billing stop credits the unused period as a REPAIR_ADJ", async () => {
    const s = await session()
    try {
      const id = await s.subscribe()
      await s.request("/test/clock?requestedDate=2030-01-11", "POST")
      await s.request(
        `/subscriptions/${id}?requestedDate=2030-01-11&billingPolicy=IMMEDIATE`,
        "DELETE",
      )
      const repair = (await s.invoices()).at(-1)
      expect(
        repair.items.map((item: { itemType: string; amount: number }) => [
          item.itemType,
          item.amount,
        ]),
      ).toEqual([
        ["REPAIR_ADJ", -67.74],
        ["CBA_ADJ", 67.74],
      ])
      expect(await s.account()).toMatchObject({ accountCBA: 67.74 })
    } finally {
      await s.server.close()
    }
  })

  test("renewal invoicing bills the due period once, then answers Tomcat's 404", async () => {
    const s = await session()
    try {
      await s.subscribe()
      const first = await s.request(
        `/invoices?accountId=${s.accountId}&targetDate=2030-02-01`,
        "POST",
      )
      expect(first.status).toBe(201)
      const again = await s.request(
        `/invoices?accountId=${s.accountId}&targetDate=2030-02-01`,
        "POST",
      )
      expect(again.status).toBe(404)
      expect(await again.text()).toContain("HTTP Status 404 – Not Found")
    } finally {
      await s.server.close()
    }
  })

  test("an adjusted external refund keeps the balance, lowers refundAdj, and is found by its key with audit", async () => {
    const s = await session()
    try {
      await s.subscribe()
      const [invoice] = await s.invoices()
      const [payment] = await s.json(`/invoices/${invoice.invoiceId}/payments`)
      const refunded = await s.request(
        `/invoicePayments/${payment.paymentId}/refunds?externalPayment=true`,
        "POST",
        {
          amount: 40,
          currency: "USD",
          transactionExternalKey: "refund-1",
          isAdjusted: true,
          adjustments: [{ invoiceItemId: invoice.items[0].invoiceItemId, amount: 40 }],
        },
        {
          "x-request-id": "11111111-2222-3333-4444-555555555555",
          "x-killbill-comment": "goodwill",
        },
      )
      expect(refunded.status).toBe(201)
      expect(await s.json(`/invoices/${invoice.invoiceId}`)).toMatchObject({
        amount: 60,
        balance: 0,
        refundAdj: -40,
      })
      const found = await s.json("/paymentTransactions?transactionExternalKey=refund-1&audit=FULL")
      expect(found).toMatchObject({ creditedAmount: 40, purchasedAmount: 0 })
      expect(found.transactions[0]).toMatchObject({ transactionType: "CREDIT", status: "SUCCESS" })
      expect(found.transactions[0].auditLogs[0]).toMatchObject({
        changeType: "INSERT",
        changedBy: "kb-0.24.16-test",
        comments: "goodwill",
        userToken: "11111111-2222-3333-4444-555555555555",
      })
      const missing = await s.request("/paymentTransactions?transactionExternalKey=nope")
      expect(missing.status).toBe(404)
      expect(await missing.json()).toMatchObject({
        code: 7020,
        message: "Payment nope does not exist",
      })
    } finally {
      await s.server.close()
    }
  })

  test("unknown ids and keys answer Kill Bill's not-found errors", async () => {
    const s = await session()
    try {
      const byKey = await s.request("/accounts?externalKey=nobody")
      expect(byKey.status).toBe(404)
      expect(await byKey.json()).toMatchObject({
        code: 3003,
        message: "Account does not exist for key nobody",
      })
      const id = "00000000-0000-0000-0000-000000000000"
      const sub = await s.request(`/subscriptions/${id}`)
      expect(sub.status).toBe(404)
      expect(await sub.json()).toMatchObject({
        message: `Object id=${id} type=SUBSCRIPTION doesn't exist!`,
      })
    } finally {
      await s.server.close()
    }
  })

  test("a catalog version already uploaded for the tenant is refused with 2080", async () => {
    const s = await session()
    try {
      const xml = `<catalog><effectiveDate>2024-01-01T00:00:00+00:00</effectiveDate><plans><plan name="xml-plan" amount="9.99"/></plans></catalog>`
      const upload = () =>
        fetch(`${s.server.url}/1.0/kb/catalog/xml`, {
          method: "POST",
          headers: { ...headers, "content-type": "text/xml" },
          body: xml,
        })
      expect((await upload()).status).toBe(201)
      const again = await upload()
      expect(again.status).toBe(400)
      expect(await again.json()).toMatchObject({ code: 2080 })
    } finally {
      await s.server.close()
    }
  })

  test("invoicing refuses a target 37 months ahead and more than 15 items in a day", async () => {
    const s = await session()
    try {
      await s.subscribe()
      const tooFar = await s.request(
        `/invoices?accountId=${s.accountId}&targetDate=2033-02-01`,
        "POST",
      )
      expect(tooFar.status).toBe(400)
      expect(await tooFar.json()).toMatchObject({
        code: 4005,
        message: "The target date was too far in the future. Target Date: 2033-02-01",
      })
      const bounded = await s.request(
        `/invoices?accountId=${s.accountId}&targetDate=2031-04-01`,
        "POST",
      )
      expect(bounded.status).toBe(400)
      expect((await bounded.json()).message).toStartWith("SAFETY BOUND TRIGGERED")
      expect(await s.invoices()).toHaveLength(1)
      const fifteen = await s.request(
        `/invoices?accountId=${s.accountId}&targetDate=2031-03-01`,
        "POST",
      )
      expect(fifteen.status).toBe(201)
    } finally {
      await s.server.close()
    }
  })

  test("invoicing through a later start bills the pending subscription", async () => {
    const s = await session()
    try {
      const created = await s.request(
        "/subscriptions?entitlementDate=2030-01-11&billingDate=2030-01-11",
        "POST",
        { accountId: s.accountId, planName: "monthly-100" },
      )
      const id = created.headers.get("location")?.split("/").at(-1) as string
      expect((await s.json(`/subscriptions/${id}`)).state).toBe("PENDING")
      const billed = await s.request(
        `/invoices?accountId=${s.accountId}&targetDate=2030-01-13`,
        "POST",
      )
      expect(billed.status).toBe(201)
      expect(await s.json(`/subscriptions/${id}`)).toMatchObject({
        state: "PENDING",
        chargedThroughDate: "2030-02-11",
      })
    } finally {
      await s.server.close()
    }
  })

  test("a credit without autoCommit is a DRAFT until commitInvoice", async () => {
    const s = await session()
    try {
      await s.request("/credits", "POST", [{ accountId: s.accountId, amount: 15, currency: "USD" }])
      expect(await s.account()).toMatchObject({ accountBalance: 0, accountCBA: 0 })
      const draft = (await s.invoices()).find(
        (invoice: { status: string }) => invoice.status === "DRAFT",
      )
      const committed = await s.request(`/invoices/${draft.invoiceId}/commitInvoice`, "PUT")
      expect(committed.status).toBe(204)
      expect(await s.account()).toMatchObject({ accountBalance: -15, accountCBA: 15 })
    } finally {
      await s.server.close()
    }
  })

  test("a generated audit userToken comes from the instance, so two instances agree", async () => {
    const tokens = []
    for (const _ of [1, 2]) {
      const s = await session()
      try {
        await s.subscribe()
        const [invoice] = await s.invoices()
        const read = await s.json(`/invoices/${invoice.invoiceId}?audit=FULL`)
        tokens.push(read.auditLogs[0]?.userToken)
      } finally {
        await s.server.close()
      }
    }
    expect(tokens[0]).toBeString()
    expect(tokens[0]).toBe(tokens[1])
  })
})

describe("Kill Bill 0.24.16 push notifications", () => {
  async function callback(fail: () => boolean) {
    const received: string[] = []
    const sink = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        received.push(((await request.json()) as { eventType: string }).eventType)
        return new Response(null, { status: fail() ? 500 : 204 })
      },
    })
    const server = await createServer({ notificationDelayMs: 50 })
    const request = (path: string, method = "GET", body?: unknown) =>
      fetch(`${server.url}/1.0/kb${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    await request("/test/clock?requestedDate=2030-01-01T12:00:00Z", "POST")
    await request(
      `/tenants/registerNotificationCallback?cb=${encodeURIComponent(sink.url.toString())}`,
      "POST",
    )
    return {
      received,
      request,
      close: async () => {
        await server.close()
        sink.stop(true)
      },
    }
  }

  test("a notification arrives after the request has answered, and test/queues waits for it", async () => {
    const s = await callback(() => false)
    try {
      expect((await s.request("/accounts", "POST", { currency: "USD" })).status).toBe(201)
      expect(s.received).toEqual([])
      expect((await s.request("/test/queues?timeoutSec=5")).status).toBe(200)
      expect(s.received).toEqual(["ACCOUNT_CREATION"])
    } finally {
      await s.close()
    }
  })

  test("a refused notification is retried 15 minutes later, then 30 minutes after that", async () => {
    let failures = 2
    const s = await callback(() => failures-- > 0)
    try {
      await s.request("/accounts", "POST", { currency: "USD" })
      await s.request("/test/queues?timeoutSec=5")
      expect(s.received).toEqual(["ACCOUNT_CREATION"])
      const at = async (instant: string) => {
        await s.request(`/test/clock?requestedDate=${instant}`, "POST")
        await s.request("/test/queues?timeoutSec=5")
        return s.received.length
      }
      expect(await at("2030-01-01T12:14:00Z")).toBe(1)
      expect(await at("2030-01-01T12:16:00Z")).toBe(2)
      expect(await at("2030-01-01T12:45:00Z")).toBe(2)
      expect(await at("2030-01-01T12:47:00Z")).toBe(3)
      expect(await at("2030-01-02T12:00:00Z")).toBe(3)
    } finally {
      await s.close()
    }
  })
})
