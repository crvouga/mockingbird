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

async function tiers() {
  const server = await createServer({
    plans: [
      { name: "low-annual", product: "Low", amount: 1200, currency: "USD", intervalDays: 365 },
      { name: "high-annual", product: "High", amount: 1800, currency: "USD", intervalDays: 365 },
    ],
  })
  const request = (path: string, method = "GET", body?: unknown) =>
    fetch(`${server.url}/1.0/kb${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const json = async (path: string) => (await request(path)).json()
  const clock = (date: string) => request(`/test/clock?requestedDate=${date}`, "POST")
  await clock("2030-01-01")
  const accountId = (await request("/accounts", "POST", { currency: "USD" })).headers
    .get("location")
    ?.split("/")
    .at(-1) as string
  await request(`/accounts/${accountId}/paymentMethods?isDefault=true`, "POST", {
    pluginName: "__EXTERNAL_PAYMENT__",
  })
  const id = (
    await request("/subscriptions", "POST", { accountId, planName: "low-annual" })
  ).headers
    .get("location")
    ?.split("/")
    .at(-1) as string
  const invoices = async () =>
    (
      (await json(`/accounts/${accountId}/invoices?includeInvoiceComponents=true`)) as Array<{
        amount: number
        items: Array<{ itemType: string; startDate: string; endDate: string; amount: number }>
      }>
    ).map((invoice) => ({
      amount: invoice.amount,
      items: invoice.items.map(
        (item) => `${item.itemType} ${item.startDate}..${item.endDate} ${item.amount}`,
      ),
    }))
  const subscription = () => json(`/subscriptions/${id}`)
  const changes = async () =>
    ((await subscription()).events as Array<{ eventType: string; plan: string }>)
      .filter((event) => event.eventType === "CHANGE")
      .map((event) => event.plan)
  return { server, request, json, clock, accountId, id, invoices, subscription, changes }
}

describe("Kill Bill 0.24.16 plan changes and renewal-day moves", () => {
  test("an immediate upgrade bills the new plan from today with a repair of the old one", async () => {
    const s = await tiers()
    try {
      await s.clock("2030-04-01")
      expect(
        (
          await s.request(`/subscriptions/${s.id}?billingPolicy=IMMEDIATE`, "PUT", {
            planName: "high-annual",
          })
        ).status,
      ).toBe(204)
      expect((await s.invoices()).at(-1)).toEqual({
        amount: 895.89,
        items: [
          "RECURRING 2030-04-01..2031-04-01 1800",
          "REPAIR_ADJ 2030-04-01..2031-01-01 -904.11",
        ],
      })
      expect(await s.subscription()).toMatchObject({
        planName: "high-annual",
        chargedThroughDate: "2031-04-01",
      })
      expect(await s.changes()).toEqual(["high-annual"])
    } finally {
      await s.server.close()
    }
  })

  test("a change on a requested day waits for it, then bills the stub to the next billing day", async () => {
    const s = await tiers()
    try {
      await s.clock("2030-04-01")
      await s.request(`/subscriptions/${s.id}?requestedDate=2030-04-11`, "PUT", {
        planName: "high-annual",
      })
      expect(await s.changes()).toEqual(["high-annual"])
      await s.clock("2030-04-10")
      expect((await s.subscription()).planName).toBe("low-annual")
      await s.clock("2030-04-11")
      expect((await s.invoices()).at(-1)?.items).toEqual([
        "RECURRING 2030-04-11..2031-04-01 1750.68",
        "REPAIR_ADJ 2030-04-11..2031-01-01 -871.23",
      ])
      expect((await s.subscription()).planName).toBe("high-annual")
    } finally {
      await s.server.close()
    }
  })

  test("an end-of-term change renews on the new plan, and a cancellation drops it", async () => {
    const renews = await tiers()
    try {
      await renews.request(`/subscriptions/${renews.id}?billingPolicy=END_OF_TERM`, "PUT", {
        planName: "high-annual",
      })
      expect((await renews.subscription()).planName).toBe("low-annual")
      await renews.clock("2031-01-02")
      expect((await renews.invoices()).at(-1)?.items).toEqual([
        "RECURRING 2031-01-01..2032-01-01 1800",
      ])
    } finally {
      await renews.server.close()
    }
    const cancelled = await tiers()
    try {
      await cancelled.request(`/subscriptions/${cancelled.id}?billingPolicy=END_OF_TERM`, "PUT", {
        planName: "high-annual",
      })
      await cancelled.request(
        `/subscriptions/${cancelled.id}?entitlementPolicy=END_OF_TERM&billingPolicy=END_OF_TERM`,
        "DELETE",
      )
      expect(await cancelled.changes()).toEqual([])
    } finally {
      await cancelled.server.close()
    }
  })

  test("a renewal-day move (hold, release, BCD) renews a full year from the new day", async () => {
    const s = await tiers()
    try {
      const block = (isBlockBilling: boolean, day: string) =>
        s.request(`/subscriptions/${s.id}/block?requestedDate=${day}`, "POST", {
          stateName: isBlockBilling ? "hold" : "release",
          service: "move",
          isBlockBilling,
          isBlockEntitlement: false,
        })
      await block(false, "2031-01-11")
      await block(true, "2031-01-01")
      await s.request(`/subscriptions/${s.id}/bcd?effectiveFromDate=2031-01-01`, "PUT", {
        billCycleDayLocal: 11,
      })
      const preview = (day: string) =>
        s.request(`/invoices/dryRun?accountId=${s.accountId}&targetDate=${day}`, "POST", {
          dryRunType: "TARGET_DATE",
        })
      expect((await preview("2031-01-10")).status).toBe(204)
      expect((await (await preview("2031-01-11")).json()).items).toMatchObject([
        { itemType: "RECURRING", startDate: "2031-01-11", endDate: "2032-01-11", amount: 1200 },
      ])
      await s.clock("2031-01-11")
      expect(await s.subscription()).toMatchObject({
        chargedThroughDate: "2032-01-11",
        billCycleDayLocal: 11,
      })
    } finally {
      await s.server.close()
    }
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

  test("notifications of several accounts each arrive one delay after their event", async () => {
    const s = await callback(() => false)
    try {
      const started = Date.now()
      await Promise.all(
        [1, 2, 3, 4, 5, 6].map(() => s.request("/accounts", "POST", { currency: "USD" })),
      )
      await s.request("/test/queues?timeoutSec=5")
      expect(s.received).toHaveLength(6)
      // With a 50 ms delay, six deliveries queued one after another would take 300 ms or more.
      expect(Date.now() - started).toBeLessThan(250)
    } finally {
      await s.close()
    }
  })

  test("a payment the callback makes while handling a notification is notified at once", async () => {
    const seen: Array<[string, number]> = []
    let server: Awaited<ReturnType<typeof createServer>> | undefined
    const call = (path: string, method = "GET", body?: unknown) =>
      fetch(`${server?.url}/1.0/kb${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const sink = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const event = (await request.json()) as {
          eventType: string
          objectId: string
          accountId: string
        }
        seen.push([event.eventType, Date.now()])
        // As a backend does: pay the new invoice from inside the INVOICE_CREATION callback.
        if (event.eventType === "INVOICE_CREATION")
          await call(`/invoices/${event.objectId}/payments?externalPayment=true`, "POST", {
            accountId: event.accountId,
            purchasedAmount: 100,
            currency: "USD",
          })
        return new Response(null, { status: 204 })
      },
    })
    server = await createServer({ notificationDelayMs: 500 })
    try {
      await call(
        `/tenants/registerNotificationCallback?cb=${encodeURIComponent(sink.url.toString())}`,
        "POST",
      )
      const accountId = (await call("/accounts", "POST", { currency: "USD" })).headers
        .get("location")
        ?.split("/")
        .at(-1) as string
      await call(`/accounts/${accountId}/tags`, "POST", ["00000000-0000-0000-0000-000000000001"])
      await call("/subscriptions", "POST", { accountId, planName: "standard-monthly" })
      await call("/test/queues?timeoutSec=10")
      const at = (type: string) => seen.find(([eventType]) => eventType === type)?.[1] ?? NaN
      const gap = at("INVOICE_PAYMENT_SUCCESS") - at("INVOICE_CREATION")
      expect(gap).toBeGreaterThanOrEqual(0)
      expect(gap).toBeLessThan(300)
    } finally {
      await server.close()
      sink.stop(true)
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

describe("Kill Bill 0.24.16 invoicing holds and account credit", () => {
  const items = async (s: Awaited<ReturnType<typeof session>>) =>
    ((await s.invoices()) as Array<{ items: Array<{ itemType: string; amount: number }> }>).map(
      (invoice) => invoice.items.map((item) => `${item.itemType} ${item.amount}`),
    )

  test("AUTO_INVOICING_OFF holds invoicing until the tag is removed", async () => {
    const s = await session()
    try {
      const tag = "00000000-0000-0000-0000-000000000002"
      await s.request(`/accounts/${s.accountId}/tags`, "POST", [tag])
      const id = await s.subscribe()
      expect(await s.invoices()).toEqual([])
      expect((await s.json(`/subscriptions/${id}`)).chargedThroughDate).toBeNull()
      expect(
        (await s.request(`/invoices?accountId=${s.accountId}&targetDate=2030-01-01`, "POST"))
          .status,
      ).toBe(201)
      expect(await s.invoices()).toEqual([])
      expect(
        (await s.request(`/accounts/${s.accountId}/tags?tagDef=${tag}`, "DELETE")).status,
      ).toBe(204)
      expect(await items(s)).toEqual([["RECURRING 100"]])
      expect((await s.json(`/subscriptions/${id}`)).chargedThroughDate).toBe("2030-02-01")
    } finally {
      await s.server.close()
    }
  })

  test("new account credit pays the open invoices first and keeps only the rest", async () => {
    const s = await session()
    try {
      await s.request(`/accounts/${s.accountId}/tags`, "POST", [
        "00000000-0000-0000-0000-000000000001",
      ])
      await s.subscribe()
      const credit = (amount: number) =>
        s.request("/credits?autoCommit=true", "POST", [
          { accountId: s.accountId, amount, currency: "USD" },
        ])
      await credit(30)
      expect((await s.invoices())[0]).toMatchObject({ balance: 70, creditAdj: -30 })
      expect(await s.account()).toMatchObject({ accountBalance: 70, accountCBA: 0 })
      await credit(100)
      expect((await items(s))[0]).toEqual(["RECURRING 100", "CBA_ADJ -30", "CBA_ADJ -70"])
      expect(await s.account()).toMatchObject({ accountBalance: -30, accountCBA: 30 })
    } finally {
      await s.server.close()
    }
  })

  test("a stop after an item adjustment repairs what the item is still worth", async () => {
    const s = await session()
    try {
      const id = await s.subscribe()
      const [invoice] = await s.invoices()
      await s.request(`/invoices/${invoice.invoiceId}`, "POST", {
        accountId: s.accountId,
        invoiceItemId: invoice.items[0].invoiceItemId,
        amount: 15,
        currency: "USD",
      })
      await s.request(
        `/subscriptions/${id}?entitlementPolicy=IMMEDIATE&billingPolicy=IMMEDIATE`,
        "DELETE",
      )
      const repair = (await s.invoices()).at(-1)
      expect(
        repair.items.map((item: { itemType: string; amount: number; description: string }) => [
          item.itemType,
          item.amount,
          item.description,
        ]),
      ).toEqual([
        ["REPAIR_ADJ", -85, "Adjustment (subscription change)"],
        ["CBA_ADJ", 85, "Adjustment (account credit)"],
      ])
      expect(await s.account()).toMatchObject({ accountCBA: 100 })
    } finally {
      await s.server.close()
    }
  })
})
