import { describe, expect, test } from "bun:test"
import { KillBillAPI } from "./src/index.js"
import { createServer } from "./src/server.js"

const headers = {
  authorization: `Basic ${btoa("admin:password")}`,
  "content-type": "application/json",
  "x-killbill-apikey": "bob",
  "x-killbill-apisecret": "lazar",
  "x-killbill-createdby": "invoice-regression",
}
const fixture = async () => {
  const events: Record<string, unknown>[] = []
  const api = new KillBillAPI({
    now: () => Date.parse("2026-01-01T00:00:00Z"),
    onEvent: (event) => {
      events.push(event)
    },
  })
  const call = (path: string, body?: unknown) =>
    api.fetch(
      new Request(`http://mock/1.0/kb${path}`, {
        headers,
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      }),
    )
  const created = await call("/accounts", { externalKey: "invoice-regression", currency: "USD" })
  const accountId = created.headers.get("location")?.split("/").at(-1) as string
  await call(`/accounts/${accountId}/paymentMethods?isDefault=true`, {
    pluginName: "fixture-plugin",
  })
  const subscription = await call("/subscriptions", { accountId, planName: "standard-monthly" })
  const subscriptionId = subscription.headers.get("location")?.split("/").at(-1) as string
  const [invoice] = await (await call(`/accounts/${accountId}/invoices`)).json()
  return { api, call, accountId, subscriptionId, invoice, events }
}

describe("invoice operations regressions", () => {
  test("partial and remaining full adjustments link items and reject invalid changes atomically", async () => {
    const { call, accountId, invoice } = await fixture()
    const path = `/invoices/${invoice.invoiceId}`
    const input = { accountId, invoiceItemId: invoice.items[0].invoiceItemId }
    expect((await call(path, { ...input, amount: 5 })).status).toBe(201)
    let current = await (await call(path)).json()
    expect(current.amount).toBe(95)
    expect(current.balance).toBe(-5)
    expect(current.items.at(-1)).toMatchObject({
      itemType: "ITEM_ADJ",
      amount: -5,
      linkedInvoiceItemId: input.invoiceItemId,
    })
    for (const invalid of [
      { ...input, amount: 96 },
      { ...input, invoiceItemId: "missing" },
      { ...input, amount: -1 },
      { ...input, amount: "5" },
      { ...input, currency: "EUR" },
    ]) {
      expect((await call(path, invalid)).status).toBe(400)
      expect(await (await call(path)).json()).toEqual(current)
    }
    expect((await call(path, input)).status).toBe(201)
    current = await (await call(path)).json()
    expect(current.amount).toBe(0)
    expect(current.balance).toBe(-100)
    expect(current.items.at(-1).amount).toBe(-95)
    expect((await call("/invoices/missing", input)).status).toBe(404)
  })

  test("target-date preview returns due recurring items without changing billing state", async () => {
    const { api, call, accountId, subscriptionId } = await fixture()
    const before = {
      invoices: api.state.invoices.list(),
      subscriptions: api.state.subscriptions.list(),
      payments: api.state.payments.list(),
    }
    expect(
      (
        await call(`/invoices/dryRun?accountId=${accountId}&targetDate=2026-01-15`, {
          dryRunType: "TARGET_DATE",
        })
      ).status,
    ).toBe(204)
    const response = await call(`/invoices/dryRun?accountId=${accountId}&targetDate=2026-02-01`, {
      dryRunType: "TARGET_DATE",
    })
    expect(response.status).toBe(200)
    const preview = await response.json()
    expect({
      invoices: api.state.invoices.list(),
      subscriptions: api.state.subscriptions.list(),
      payments: api.state.payments.list(),
    }).toEqual(before)
    const subscription = api.state.subscriptions.get(subscriptionId)
    if (!subscription) throw new Error("Subscription fixture missing")
    api.state.subscriptions.insert(subscriptionId, {
      ...subscription,
      blockingStates: [
        {
          stateName: "paused",
          service: "fixture",
          isBlockBilling: true,
          effectiveDate: "2026-01-10",
        },
        {
          stateName: "resumed",
          service: "fixture",
          isBlockBilling: false,
          effectiveDate: "2026-02-01",
        },
      ],
    })
    expect(
      (
        await call(`/invoices/dryRun?accountId=${accountId}&targetDate=2026-01-31`, {
          dryRunType: "TARGET_DATE",
        })
      ).status,
    ).toBe(204)
    expect(
      (
        await call(`/invoices/dryRun?accountId=${accountId}&targetDate=2026-02-01`, {
          dryRunType: "TARGET_DATE",
        })
      ).status,
    ).toBe(200)
    api.state.subscriptions.insert(subscriptionId, subscription)
    expect(preview.items).toContainEqual(
      expect.objectContaining({
        subscriptionId,
        itemType: "RECURRING",
        amount: 100,
        startDate: "2026-01-31",
      }),
    )
    expect(
      (
        await call(`/invoices/dryRun?accountId=missing&targetDate=2026-02-01`, {
          dryRunType: "TARGET_DATE",
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await call(`/invoices/dryRun?accountId=${accountId}&targetDate=invalid`, {
          dryRunType: "TARGET_DATE",
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await call(`/invoices/dryRun?accountId=${accountId}&targetDate=2026-02-01`, {
          dryRunAction: "CHANGE",
        })
      ).status,
    ).toBe(400)
  })

  test("auto and explicit invoice payments emit invoice success/failure but pending does not", async () => {
    const { api, call, accountId, invoice, events } = await fixture()
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: "INVOICE_PAYMENT_SUCCESS",
        objectType: "INVOICE",
        objectId: invoice.invoiceId,
        accountId,
      }),
    )
    events.length = 0
    api.state.settings.insert("settings", { declineNext: true, pendingNext: false })
    await call(`/invoices/${invoice.invoiceId}/payments`, { accountId, purchasedAmount: 10 })
    expect(events.map((event) => event.eventType)).toEqual([
      "PAYMENT_FAILED",
      "INVOICE_PAYMENT_FAILED",
    ])
    expect(events[1]).toMatchObject({
      objectType: "INVOICE",
      objectId: invoice.invoiceId,
      accountId,
    })
    events.length = 0
    api.state.settings.insert("settings", { declineNext: false, pendingNext: true })
    await call(`/invoices/${invoice.invoiceId}/payments`, { accountId, purchasedAmount: 10 })
    expect(events.map((event) => event.eventType)).toEqual(["PAYMENT_PENDING"])
    events.length = 0
    await call(`/invoices/${invoice.invoiceId}/payments?externalPayment=true`, {
      accountId,
      purchasedAmount: 10,
    })
    expect(events.map((event) => event.eventType)).toEqual([
      "PAYMENT_SUCCESS",
      "INVOICE_PAYMENT_SUCCESS",
    ])
  })
})

test("tenant callbacks receive invoice success for auto-pay, account payment, and admin retry", async () => {
  const deliveries: Record<string, unknown>[] = []
  const sink = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      deliveries.push((await request.json()) as Record<string, unknown>)
      return new Response(null, { status: 204 })
    },
  })
  const server = await createServer()
  const call = (path: string, body?: unknown, method?: string) =>
    fetch(`${server.url}${path}`, {
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      method: method ?? (body === undefined ? "GET" : "POST"),
    })
  try {
    await call(
      `/1.0/kb/tenants/registerNotificationCallback?cb=${encodeURIComponent(sink.url.toString())}`,
      {},
    )
    const account = await call("/1.0/kb/accounts", {
      currency: "USD",
      externalKey: "callback-fixture",
    })
    const accountId = account.headers.get("location")?.split("/").at(-1) as string
    await call(`/1.0/kb/accounts/${accountId}/paymentMethods?isDefault=true`, {
      pluginName: "fixture-plugin",
    })
    await call("/1.0/kb/subscriptions", { accountId, planName: "standard-monthly" })
    const [invoice] = await (await call(`/1.0/kb/accounts/${accountId}/invoices`)).json()
    expect(deliveries).toContainEqual(
      expect.objectContaining({
        eventType: "INVOICE_PAYMENT_SUCCESS",
        objectType: "INVOICE",
        objectId: invoice.invoiceId,
        accountId,
      }),
    )
    const charged = await call(`/1.0/kb/invoices/charges/${accountId}`, [{ amount: 25 }])
    const invoiceId = charged.headers.get("location")?.split("/").at(-1) as string
    const unpaid = await (await call(`/1.0/kb/invoices/${invoiceId}`)).json()
    expect(
      (
        await call(`/1.0/kb/invoices/${invoiceId}`, {
          accountId,
          invoiceItemId: unpaid.items[0].invoiceItemId,
          amount: 5,
        })
      ).status,
    ).toBe(201)
    expect((await (await call(`/1.0/kb/invoices/${invoiceId}`)).json()).balance).toBe(20)
    await call("/__admin/payments/decline-next", {})
    deliveries.length = 0
    expect((await call(`/1.0/kb/accounts/${accountId}/invoicePayments`, {})).status).toBe(201)
    expect(deliveries).toContainEqual(
      expect.objectContaining({ eventType: "INVOICE_PAYMENT_FAILED", objectId: invoiceId }),
    )
    const payments = await (await call(`/1.0/kb/invoices/${invoiceId}/payments`)).json()
    deliveries.length = 0
    expect((await call(`/__admin/payments/${payments[0].paymentId}/retry`, {})).status).toBe(200)
    expect(deliveries.map((event) => event.eventType)).toEqual([
      "PAYMENT_SUCCESS",
      "INVOICE_PAYMENT_SUCCESS",
    ])
    expect(deliveries[1]).toMatchObject({ objectType: "INVOICE", objectId: invoiceId, accountId })
    expect((await (await call(`/1.0/kb/invoices/${invoiceId}`)).json()).balance).toBe(0)
    expect((await call(`/1.0/kb/accounts/${accountId}/invoicePayments`, {})).status).toBe(204)
  } finally {
    await server.close()
    sink.stop(true)
  }
})
