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
  const [invoice] = await (
    await call(`/accounts/${accountId}/invoices?includeInvoiceComponents=true`)
  ).json()
  return { api, call, accountId, subscriptionId, invoice, events }
}

describe("invoice operations regressions", () => {
  test("partial and remaining full adjustments link items and reject invalid changes atomically", async () => {
    const { call, accountId, invoice } = await fixture()
    const path = `/invoices/${invoice.invoiceId}`
    const input = { accountId, invoiceItemId: invoice.items[0].invoiceItemId }
    expect((await call(path, { ...input, amount: 5 })).status).toBe(201)
    let current = await (await call(path)).json()
    // Kill Bill 0.24.16 (parity scenario item-adjust-paid): adjusting a paid item keeps the
    // balance at 0 and turns the adjustment into account credit.
    expect(current).toMatchObject({ amount: 95, balance: 0, creditAdj: 5 })
    expect(current.items.slice(-2)).toMatchObject([
      { itemType: "ITEM_ADJ", amount: -5, linkedInvoiceItemId: input.invoiceItemId },
      { itemType: "CBA_ADJ", amount: 5, description: "Adjustment (account credit)" },
    ])
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
    expect(current).toMatchObject({ amount: 0, balance: 0, creditAdj: 100 })
    expect(current.items.at(-2)).toMatchObject({ itemType: "ITEM_ADJ", amount: -95 })
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
        // Kill Bill 0.24.16 bills calendar months: a 2026-01-01 start renews on 2026-02-01.
        startDate: "2026-02-01",
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
    const charge = await call(`/invoices/charges/${accountId}`, [
      { amount: 30, currency: "USD", description: "Visit" },
    ])
    const unpaidInvoiceId = charge.headers.get("location")?.split("/").at(-1) as string
    events.length = 0
    api.state.settings.insert("settings", { declineNext: true, pendingNext: false })
    await call(`/invoices/${unpaidInvoiceId}/payments`, { accountId, purchasedAmount: 10 })
    expect(events.map((event) => event.eventType)).toEqual([
      "PAYMENT_FAILED",
      "INVOICE_PAYMENT_FAILED",
    ])
    expect(events[1]).toMatchObject({
      objectType: "INVOICE",
      objectId: unpaidInvoiceId,
      accountId,
    })
    events.length = 0
    api.state.settings.insert("settings", { declineNext: false, pendingNext: true })
    await call(`/invoices/${unpaidInvoiceId}/payments`, { accountId, purchasedAmount: 10 })
    expect(events.map((event) => event.eventType)).toEqual(["PAYMENT_PENDING"])
    events.length = 0
    await call(`/invoices/${unpaidInvoiceId}/payments?externalPayment=true`, {
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
  const server = await createServer({ notificationDelayMs: 0 })
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
    // Kill Bill delivers notifications after the request; GET /test/queues waits for them.
    await call("/1.0/kb/test/queues?timeoutSec=10")
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
    await call("/1.0/kb/test/queues?timeoutSec=10")
    expect(deliveries).toContainEqual(
      expect.objectContaining({ eventType: "INVOICE_PAYMENT_FAILED", objectId: invoiceId }),
    )
    const payments = await (await call(`/1.0/kb/invoices/${invoiceId}/payments`)).json()
    deliveries.length = 0
    expect((await call(`/__admin/payments/${payments[0].paymentId}/retry`, {})).status).toBe(200)
    await call("/1.0/kb/test/queues?timeoutSec=10")
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

describe("invoice payments stop at the invoice balance (oracle: Kill Bill 0.24.10)", () => {
  const billing = async ({
    paymentMethod,
    autoPayOff = false,
  }: {
    paymentMethod?: "__EXTERNAL_PAYMENT__"
    autoPayOff?: boolean
  } = {}) => {
    const api = new KillBillAPI({ now: () => Date.parse("2026-01-01T00:00:00Z") })
    const call = (path: string, body?: unknown) =>
      api.fetch(
        new Request(`http://mock/1.0/kb${path}`, {
          headers,
          ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        }),
      )
    const created = await call("/accounts", { externalKey: "balance-limit", currency: "USD" })
    const accountId = created.headers.get("location")?.split("/").at(-1) as string
    if (autoPayOff)
      await call(`/accounts/${accountId}/tags`, ["00000000-0000-0000-0000-000000000001"])
    if (paymentMethod)
      await call(`/accounts/${accountId}/paymentMethods?isDefault=true`, {
        pluginName: paymentMethod,
      })
    await call("/subscriptions", { accountId, planName: "standard-monthly" })
    const [{ invoiceId }] = await (await call(`/accounts/${accountId}/invoices`)).json()
    const pay = (body: Record<string, unknown>, external = true) =>
      call(`/invoices/${invoiceId}/payments${external ? "?externalPayment=true" : ""}`, {
        accountId,
        ...body,
      })
    const purchased = async () =>
      (
        (await (await call(`/invoices/${invoiceId}/payments`)).json()) as {
          purchasedAmount: number
        }[]
      )
        .map((payment) => payment.purchasedAmount)
        .sort((a, b) => a - b)
    const balance = async () => (await (await call(`/invoices/${invoiceId}`)).json()).balance
    return { call, accountId, invoiceId, pay, purchased, balance }
  }

  test("a payment recorded after auto-pay settled the invoice is not taken twice", async () => {
    const { pay, purchased, balance } = await billing({ paymentMethod: "__EXTERNAL_PAYMENT__" })
    expect(await balance()).toBe(0)
    expect(await purchased()).toEqual([100])
    const recorded = await pay({
      purchasedAmount: 100,
      currency: "USD",
      paymentExternalKey: "checkout",
    })
    expect(recorded.status).toBe(204)
    expect(await recorded.text()).toBe("")
    expect((await pay({})).status).toBe(204)
    expect(await purchased()).toEqual([100])
  })

  test("an AUTO_PAY_OFF account is not auto-paid and its invoice waits for the recorded payment", async () => {
    const { pay, purchased, balance } = await billing({
      paymentMethod: "__EXTERNAL_PAYMENT__",
      autoPayOff: true,
    })
    expect(await balance()).toBe(100)
    expect(await purchased()).toEqual([])
    expect(
      (await pay({ purchasedAmount: 100, currency: "USD", paymentExternalKey: "checkout" })).status,
    ).toBe(201)
    expect(await purchased()).toEqual([100])
    expect(await balance()).toBe(0)
  })

  test("an amount above the balance is refused and records nothing", async () => {
    const { invoiceId, pay, purchased, balance } = await billing()
    const refused = await pay({ purchasedAmount: 150, currency: "USD" })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toEqual({
      className: "org.killbill.billing.payment.api.PaymentApiException",
      code: 7199,
      message: `Plugin exception Invalid amount '150' for invoice '${invoiceId}': invoice balance is = '100.00'`,
      causeClassName: null,
      causeMessage: null,
      stackTrace: [],
    })
    expect(await purchased()).toEqual([])
    expect(await balance()).toBe(100)

    expect((await pay({ purchasedAmount: 40, currency: "USD" })).status).toBe(201)
    const aboveRemainder = await pay({ purchasedAmount: 100, currency: "USD" })
    expect(aboveRemainder.status).toBe(400)
    expect((await aboveRemainder.json()).message).toEndWith("invoice balance is = '60.00'")
    expect((await pay({})).status).toBe(201)
    expect(await purchased()).toEqual([40, 60])
    expect(await balance()).toBe(0)
  })

  test("payments through a payment method follow the same limits", async () => {
    const { call, accountId, pay, purchased } = await billing()
    const method = await call(`/accounts/${accountId}/paymentMethods`, {
      pluginName: "fixture-plugin",
    })
    const paymentMethodId = method.headers.get("location")?.split("/").at(-1) as string
    expect((await pay({ paymentMethodId, purchasedAmount: 150 }, false)).status).toBe(400)
    expect((await pay({ paymentMethodId }, false)).status).toBe(201)
    expect((await pay({ paymentMethodId, purchasedAmount: 10 }, false)).status).toBe(204)
    expect(await purchased()).toEqual([100])
  })

  test("an invoice credited below zero takes no payment", async () => {
    const { call, accountId, invoiceId, pay, purchased } = await billing({
      paymentMethod: "__EXTERNAL_PAYMENT__",
    })
    const [item] = (await (await call(`/invoices/${invoiceId}`)).json()).items
    expect(
      (
        await call(`/invoices/${invoiceId}`, {
          accountId,
          invoiceItemId: item.invoiceItemId,
          amount: 5,
        })
      ).status,
    ).toBe(201)
    expect((await pay({ purchasedAmount: 1, currency: "USD" })).status).toBe(204)
    expect((await pay({})).status).toBe(204)
    expect(await purchased()).toEqual([100])
  })
})

test("a notification consumer paying on INVOICE_CREATION finds the invoice already auto-paid", async () => {
  const server = await createServer({ notificationDelayMs: 0 })
  const call = (path: string, body?: unknown) =>
    fetch(`${server.url}/1.0/kb${path}`, {
      headers,
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    })
  // Kill Bill 0.24.16: auto-pay runs before the INVOICE_CREATION notification is delivered, so the
  // consumer's payment finds nothing owed (204) and the invoice has one payment.
  const consumerPaid: number[] = []
  const sink = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const event = (await request.json()) as {
        eventType: string
        objectId: string
        accountId: string
      }
      if (event.eventType === "INVOICE_CREATION")
        consumerPaid.push(
          (
            await call(`/invoices/${event.objectId}/payments?externalPayment=true`, {
              accountId: event.accountId,
              purchasedAmount: 100,
              currency: "USD",
              paymentExternalKey: "checkout",
            })
          ).status,
        )
      return new Response(null, { status: 204 })
    },
  })
  try {
    await call(
      `/tenants/registerNotificationCallback?cb=${encodeURIComponent(sink.url.toString())}`,
      {},
    )
    const created = await call("/accounts", { currency: "USD", externalKey: "consumer-paid" })
    const accountId = created.headers.get("location")?.split("/").at(-1) as string
    await call(`/accounts/${accountId}/paymentMethods?isDefault=true`, {
      pluginName: "__EXTERNAL_PAYMENT__",
    })
    await call("/subscriptions", { accountId, planName: "standard-monthly" })
    await call("/test/queues?timeoutSec=10")
    expect(consumerPaid).toEqual([204])
    const [invoice] = await (
      await call(`/accounts/${accountId}/invoices?includeInvoiceComponents=true`)
    ).json()
    const payments = (await (await call(`/invoices/${invoice.invoiceId}/payments`)).json()) as {
      paymentExternalKey: string
      purchasedAmount: number
    }[]
    expect(
      payments.map(({ paymentExternalKey, purchasedAmount }) => ({
        paymentExternalKey,
        purchasedAmount,
      })),
    ).toEqual([expect.objectContaining({ purchasedAmount: 100 })])
    expect(payments[0]?.paymentExternalKey).not.toBe("checkout")
    expect((await (await call(`/invoices/${invoice.invoiceId}`)).json()).balance).toBe(0)
  } finally {
    await server.close()
    sink.stop(true)
  }
})
