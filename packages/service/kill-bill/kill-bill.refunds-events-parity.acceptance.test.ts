import { describe, expect, test } from "bun:test"
import { createServer } from "./src/server.js"

// Behaviour captured from a live Kill Bill 0.24.10 (API 0.54.0) on 2026-11-05 by the reproductions
// in GitHub issues #648–#652: a fresh tenant, this catalog (no <billingAlignment> rule), an
// AUTO_PAY_OFF account, and the same steps run against both servers.

const AUTO_PAY_OFF = "00000000-0000-0000-0000-000000000001"

const plan = (name: string, period: string, price: string) =>
  `<plan name="${name}"><product>Membership</product><initialPhases/><finalPhase type="EVERGREEN"><duration><unit>UNLIMITED</unit></duration><recurring><billingPeriod>${period}</billingPeriod><recurringPrice><price><currency>USD</currency><value>${price}</value></price></recurringPrice></recurring></finalPhase></plan>`

const CATALOG = `<?xml version="1.0" encoding="UTF-8"?><catalog><effectiveDate>2020-01-01T00:00:00+00:00</effectiveDate><catalogName>repro</catalogName><recurringBillingMode>IN_ADVANCE</recurringBillingMode><currencies><currency>USD</currency></currencies><products><product name="Membership"><category>BASE</category></product></products><rules><changePolicy><changePolicyCase><policy>END_OF_TERM</policy></changePolicyCase></changePolicy><cancelPolicy><cancelPolicyCase><policy>END_OF_TERM</policy></cancelPolicyCase></cancelPolicy></rules><plans>${plan("repro-monthly", "MONTHLY", "100.00")}${plan("repro-annual", "ANNUAL", "1500.00")}</plans><priceLists><defaultPriceList name="DEFAULT"><plans><plan>repro-monthly</plan><plan>repro-annual</plan></plans></defaultPriceList></priceLists></catalog>`

const headers = {
  authorization: `Basic ${btoa("admin:password")}`,
  "content-type": "application/json",
  accept: "application/json",
  "x-killbill-apikey": "bob",
  "x-killbill-apisecret": "lazar",
  "x-killbill-createdby": "repro",
}

type Invoice = {
  invoiceId: string
  amount: number
  balance: number
  refundAdj: number
  items: { invoiceItemId: string; itemType: string; amount: number; auditLogs?: AuditLog[] }[]
}
type AuditLog = { changeType: string; userToken: string | null }

async function session() {
  const received: string[] = []
  const sink = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const event = (await request.json()) as { eventType: string; objectType: string }
      received.push(`${event.eventType}/${event.objectType}`)
      return new Response(null, { status: 204 })
    },
  })
  const server = await createServer({ notificationDelayMs: 0 })
  const call = (path: string, method = "GET", body?: unknown, contentType?: string) =>
    fetch(`${server.url}/1.0/kb${path}`, {
      method,
      headers: { ...headers, ...(contentType ? { "content-type": contentType } : {}) },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    })
  const json = async (path: string) => (await call(path)).json()
  const id = (response: Response) => response.headers.get("location")?.split("/").at(-1) as string
  await call("/test/clock?requestedDate=2026-11-05T12:00:00Z", "POST")
  await call("/catalog/xml", "POST", CATALOG, "text/xml")
  const account = async () => {
    const accountId = id(
      await call("/accounts", "POST", {
        name: "Jane Doe",
        externalKey: `ext-${crypto.randomUUID()}`,
        currency: "USD",
        timeZone: "UTC",
      }),
    )
    await call(`/accounts/${accountId}/tags`, "POST", [AUTO_PAY_OFF])
    return accountId
  }
  const subscribe = async (accountId: string, planName = "repro-monthly") =>
    id(await call("/subscriptions?callCompletion=true", "POST", { accountId, planName }))
  const paidInvoice = async () => {
    const accountId = await account()
    await subscribe(accountId)
    const [invoice] = (await json(
      `/accounts/${accountId}/invoices?withItems=true&includeInvoiceComponents=true`,
    )) as Invoice[]
    if (!invoice) throw new Error("no invoice")
    await call(`/invoices/${invoice.invoiceId}/payments?externalPayment=true`, "POST", {
      accountId,
      targetInvoiceId: invoice.invoiceId,
      purchasedAmount: 100,
      currency: "USD",
      paymentExternalKey: `pay-${crypto.randomUUID()}`,
    })
    const [payment] = (await json(`/invoices/${invoice.invoiceId}/payments`)) as {
      paymentId: string
    }[]
    const item = invoice.items.find((row) => row.itemType === "RECURRING")
    if (!payment || !item) throw new Error("no payment or item")
    return { accountId, invoice, paymentId: payment.paymentId, itemId: item.invoiceItemId }
  }
  const invoiceNow = async (invoiceId: string) => {
    const { amount, balance, refundAdj, items } = (await json(
      `/invoices/${invoiceId}?withItems=true`,
    )) as Invoice
    return { amount, balance, refundAdj, items: items.map((i) => `${i.itemType} ${i.amount}`) }
  }
  const refund = (
    paymentId: string,
    body: Record<string, unknown>,
    query = "?externalPayment=true",
  ) =>
    call(`/invoicePayments/${paymentId}/refunds${query}`, "POST", {
      currency: "USD",
      transactionExternalKey: `rf-${crypto.randomUUID()}`,
      ...body,
    })
  /** Every push notification sent since the last step, once the queues have drained. */
  const step = async () => {
    await call("/test/queues?timeoutSec=10")
    return received.splice(0)
  }
  await call(
    `/tenants/registerNotificationCallback?cb=${encodeURIComponent(sink.url.toString())}`,
    "POST",
  )
  await step()
  return {
    call,
    json,
    account,
    subscribe,
    paidInvoice,
    invoiceNow,
    refund,
    step,
    close: async () => {
      await server.close()
      sink.stop(true)
    },
  }
}

describe("#648 adjusted refund of an external invoice payment", () => {
  test("isAdjusted with adjustments lowers the invoice amount, keeps the balance, and refundAdj is negative", async () => {
    const s = await session()
    try {
      const p = await s.paidInvoice()
      const refunded = await s.refund(p.paymentId, {
        amount: 40,
        isAdjusted: true,
        adjustments: [
          { invoiceItemId: p.itemId, invoiceId: p.invoice.invoiceId, amount: 40, currency: "USD" },
        ],
      })
      expect(refunded.status).toBe(201)
      expect(await s.invoiceNow(p.invoice.invoiceId)).toEqual({
        amount: 60,
        balance: 0,
        refundAdj: -40,
        items: ["RECURRING 100", "ITEM_ADJ -40"],
      })
    } finally {
      await s.close()
    }
  })

  test("isAdjusted with no adjustments records only the CREDIT payment and leaves the invoice alone", async () => {
    const s = await session()
    try {
      const p = await s.paidInvoice()
      const refunded = await s.refund(p.paymentId, { amount: 40, isAdjusted: true })
      expect(refunded.status).toBe(201)
      expect(await s.invoiceNow(p.invoice.invoiceId)).toEqual({
        amount: 100,
        balance: 0,
        refundAdj: 0,
        items: ["RECURRING 100"],
      })
      const credit = await s.json(
        `/invoicePayments/${refunded.headers.get("location")?.split("/").at(-1)}`,
      )
      expect(credit).toMatchObject({ creditedAmount: 40 })
    } finally {
      await s.close()
    }
  })

  test("with externalPayment=true a refund above the original payment is accepted", async () => {
    const s = await session()
    try {
      const p = await s.paidInvoice()
      const over = await s.refund(p.paymentId, { amount: 150, isAdjusted: true })
      expect(over.status).toBe(201)
      const credit = await s.json(
        `/invoicePayments/${over.headers.get("location")?.split("/").at(-1)}`,
      )
      expect(credit).toMatchObject({ creditedAmount: 150 })
    } finally {
      await s.close()
    }
  })

  test("without externalPayment, isAdjusted with no adjustments is refused with 7199 and records nothing", async () => {
    const s = await session()
    try {
      const p = await s.paidInvoice()
      const refused = await s.refund(p.paymentId, { amount: 40, isAdjusted: true }, "")
      expect(refused.status).toBe(400)
      expect(await refused.json()).toMatchObject({
        className: "org.killbill.billing.payment.api.PaymentApiException",
        code: 7199,
        message: expect.stringContaining("Missing invoice item adjustements during payment refund"),
      })
      expect(await s.invoiceNow(p.invoice.invoiceId)).toEqual({
        amount: 100,
        balance: 0,
        refundAdj: 0,
        items: ["RECURRING 100"],
      })
      const [payment] = await s.json(`/invoices/${p.invoice.invoiceId}/payments`)
      expect(payment).toMatchObject({ refundedAmount: 0 })
    } finally {
      await s.close()
    }
  })
})

describe("#649 refund lookup by transaction key and audit logs on invoice items", () => {
  const adjustedRefund = async (s: Awaited<ReturnType<typeof session>>, key: string) => {
    const p = await s.paidInvoice()
    await s.refund(p.paymentId, {
      amount: 40,
      transactionExternalKey: key,
      isAdjusted: true,
      adjustments: [
        { invoiceItemId: p.itemId, invoiceId: p.invoice.invoiceId, amount: 40, currency: "USD" },
      ],
    })
    return p
  }
  const insertToken = (logs: AuditLog[] | undefined) =>
    (logs ?? []).find((log) => log.changeType === "INSERT")?.userToken ?? null

  test("GET /paymentTransactions?transactionExternalKey= returns the owning payment with audit logs", async () => {
    const s = await session()
    try {
      const p = await adjustedRefund(s, "refund-key-1")
      const lookup = await s.call(
        "/paymentTransactions?transactionExternalKey=refund-key-1&audit=FULL",
      )
      expect(lookup.status).toBe(200)
      const payment = (await lookup.json()) as {
        accountId: string
        transactions: {
          transactionExternalKey: string
          transactionType: string
          amount: number
          status: string
          auditLogs: AuditLog[]
        }[]
      }
      expect(payment.accountId).toBe(p.accountId)
      const tx = payment.transactions.find((row) => row.transactionExternalKey === "refund-key-1")
      expect(tx && `${tx.transactionType} ${tx.amount} ${tx.status}`).toBe("CREDIT 40 SUCCESS")
      expect(insertToken(tx?.auditLogs)).not.toBeNull()
      const missing = await s.call("/paymentTransactions?transactionExternalKey=no-such-key")
      expect(missing.status).toBe(404)
      expect(await missing.json()).toMatchObject({
        className: "org.killbill.billing.payment.api.PaymentApiException",
      })
    } finally {
      await s.close()
    }
  })

  test("audit=FULL gives invoice items audit logs, and the ITEM_ADJ shares the CREDIT's INSERT userToken", async () => {
    const s = await session()
    try {
      const p = await adjustedRefund(s, "refund-key-2")
      const payment = await s.json(
        "/paymentTransactions?transactionExternalKey=refund-key-2&audit=FULL",
      )
      const credit = insertToken(payment.transactions[0].auditLogs)
      const audited = (await s.json(
        `/invoices/${p.invoice.invoiceId}?withItems=true&audit=FULL`,
      )) as Invoice
      const adjustments = audited.items.filter((item) => item.itemType === "ITEM_ADJ")
      expect(adjustments.map((item) => insertToken(item.auditLogs) === credit)).toEqual([true])
      for (const item of audited.items)
        expect(item.auditLogs?.[0]).toMatchObject({
          changeType: "INSERT",
          changeDate: expect.any(String),
          changedBy: expect.any(String),
          reasonCode: null,
          comments: null,
          userToken: expect.any(String),
        })
    } finally {
      await s.close()
    }
  })
})

describe("#650 external payment above the invoice balance", () => {
  test("is refused with 7199, records no payment and sends no event", async () => {
    const s = await session()
    try {
      const accountId = await s.account()
      await s.subscribe(accountId)
      const [invoice] = (await s.json(
        `/accounts/${accountId}/invoices?withItems=true&includeInvoiceComponents=true`,
      )) as Invoice[]
      if (!invoice) throw new Error("no invoice")
      await s.step()
      const res = await s.call(
        `/invoices/${invoice.invoiceId}/payments?externalPayment=true`,
        "POST",
        {
          accountId,
          targetInvoiceId: invoice.invoiceId,
          purchasedAmount: 150,
          currency: "USD",
          paymentExternalKey: "pay-150",
        },
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({
        className: "org.killbill.billing.payment.api.PaymentApiException",
        code: 7199,
        message: `Plugin exception Invalid amount '150' for invoice '${invoice.invoiceId}': invoice balance is = '100.00'`,
      })
      expect(await s.json(`/invoices/${invoice.invoiceId}/payments`)).toEqual([])
      expect(await s.json(`/accounts/${accountId}?accountWithBalanceAndCBA=true`)).toMatchObject({
        accountBalance: 100,
        accountCBA: 0,
      })
      expect(await s.step()).toEqual([])
    } finally {
      await s.close()
    }
  })

  test("an amount up to the balance keeps working", async () => {
    const s = await session()
    try {
      const accountId = await s.account()
      await s.subscribe(accountId)
      const [invoice] = (await s.json(
        `/accounts/${accountId}/invoices?withItems=true&includeInvoiceComponents=true`,
      )) as Invoice[]
      if (!invoice) throw new Error("no invoice")
      const res = await s.call(
        `/invoices/${invoice.invoiceId}/payments?externalPayment=true`,
        "POST",
        {
          accountId,
          purchasedAmount: 100,
          currency: "USD",
        },
      )
      expect(res.status).toBe(201)
      expect((await s.invoiceNow(invoice.invoiceId)).balance).toBe(0)
    } finally {
      await s.close()
    }
  })
})

describe("#651 plan change to a plan the catalog does not have", () => {
  const change = async (body: Record<string, unknown>) => {
    const s = await session()
    try {
      const subscriptionId = await s.subscribe(await s.account())
      const res = await s.call(
        `/subscriptions/${subscriptionId}?billingPolicy=IMMEDIATE`,
        "PUT",
        body,
      )
      return { status: res.status, body: res.status === 204 ? null : await res.json() }
    } finally {
      await s.close()
    }
  }
  const CATALOG_EXCEPTION = "org.killbill.billing.catalog.api.CatalogApiException"

  test("an unknown plan name is CatalogApiException 2021", async () => {
    expect(await change({ planName: "not-in-catalog-monthly" })).toEqual({
      status: 400,
      body: expect.objectContaining({
        className: CATALOG_EXCEPTION,
        code: 2021,
        message: "Could not find any plans named 'not-in-catalog-monthly'",
      }),
    })
  })

  test("a product with no plan for that billing period and price list is CatalogApiException 2020", async () => {
    expect(
      await change({ productName: "Membership", billingPeriod: "QUARTERLY", priceList: "DEFAULT" }),
    ).toEqual({
      status: 400,
      body: expect.objectContaining({
        className: CATALOG_EXCEPTION,
        code: 2020,
        message:
          "Could not find a plan matching spec: (plan: 'undefined', product: 'Membership', billing period: 'QUARTERLY', pricelist 'DEFAULT')",
      }),
    })
  })

  test("an unknown product is CatalogApiException 2030", async () => {
    expect(
      await change({
        productName: "NoSuchProduct",
        billingPeriod: "MONTHLY",
        priceList: "DEFAULT",
      }),
    ).toEqual({
      status: 400,
      body: expect.objectContaining({
        className: CATALOG_EXCEPTION,
        code: 2030,
        message: "Could not find any product named 'NoSuchProduct'",
      }),
    })
  })

  test("a valid plan change keeps returning 204, by name or by product spec", async () => {
    expect(await change({ planName: "repro-annual" })).toEqual({ status: 204, body: null })
    expect(
      await change({ productName: "Membership", billingPeriod: "ANNUAL", priceList: "DEFAULT" }),
    ).toEqual({
      status: 204,
      body: null,
    })
  })
})

describe("#652 push notifications", () => {
  test("tagging, creating, paying, an adjusted refund and an immediate cancel send Kill Bill's events", async () => {
    const s = await session()
    try {
      const accountId = await s.account()
      expect(await s.step()).toEqual(["ACCOUNT_CREATION/ACCOUNT", "TAG_CREATION/TAG"])
      const subscriptionId = await s.subscribe(accountId)
      const [invoice] = (await s.json(
        `/accounts/${accountId}/invoices?withItems=true&includeInvoiceComponents=true`,
      )) as Invoice[]
      if (!invoice) throw new Error("no invoice")
      const created = await s.step()
      expect(created.slice(0, 2)).toEqual([
        "SUBSCRIPTION_CREATION/SUBSCRIPTION",
        "ENTITLEMENT_CREATION/SUBSCRIPTION",
      ])
      expect(
        created.filter((event) => event === "SUBSCRIPTION_CREATION/SUBSCRIPTION"),
      ).toHaveLength(2)
      expect(created.at(-1)).toBe("INVOICE_CREATION/INVOICE")
      await s.call(`/invoices/${invoice.invoiceId}/payments?externalPayment=true`, "POST", {
        accountId,
        purchasedAmount: 100,
        currency: "USD",
      })
      expect(await s.step()).toEqual(["PAYMENT_SUCCESS/PAYMENT", "INVOICE_PAYMENT_SUCCESS/INVOICE"])
      const [payment] = await s.json(`/invoices/${invoice.invoiceId}/payments`)
      const itemId = invoice.items.find((item) => item.itemType === "RECURRING")?.invoiceItemId
      await s.refund(payment.paymentId, {
        amount: 40,
        isAdjusted: true,
        adjustments: [
          { invoiceItemId: itemId, invoiceId: invoice.invoiceId, amount: 40, currency: "USD" },
        ],
      })
      expect(await s.step()).toEqual([
        "PAYMENT_SUCCESS/PAYMENT",
        "INVOICE_ADJUSTMENT/INVOICE",
        "INVOICE_PAYMENT_SUCCESS/INVOICE",
      ])
      await s.call(
        `/subscriptions/${subscriptionId}?entitlementPolicy=IMMEDIATE&billingPolicy=IMMEDIATE`,
        "DELETE",
      )
      const cancelled = await s.step()
      expect(cancelled.slice(0, 3)).toEqual([
        "SUBSCRIPTION_CANCEL/SUBSCRIPTION",
        "ENTITLEMENT_CANCEL/SUBSCRIPTION",
        "SUBSCRIPTION_CANCEL/SUBSCRIPTION",
      ])
    } finally {
      await s.close()
    }
  })

  test("an adjusted refund's invoice events name the invoice", async () => {
    const s = await session()
    try {
      const p = await s.paidInvoice()
      await s.step()
      const bodies: { eventType: string; objectId: string }[] = []
      const sink = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          bodies.push((await request.json()) as { eventType: string; objectId: string })
          return new Response(null, { status: 204 })
        },
      })
      try {
        await s.call(
          `/tenants/registerNotificationCallback?cb=${encodeURIComponent(sink.url.toString())}`,
          "POST",
        )
        await s.refund(p.paymentId, {
          amount: 40,
          isAdjusted: true,
          adjustments: [
            {
              invoiceItemId: p.itemId,
              invoiceId: p.invoice.invoiceId,
              amount: 40,
              currency: "USD",
            },
          ],
        })
        await s.step()
        expect(bodies.filter((body) => body.eventType.startsWith("INVOICE_"))).toEqual([
          expect.objectContaining({
            eventType: "INVOICE_ADJUSTMENT",
            objectId: p.invoice.invoiceId,
          }),
          expect.objectContaining({
            eventType: "INVOICE_PAYMENT_SUCCESS",
            objectId: p.invoice.invoiceId,
          }),
        ])
      } finally {
        sink.stop(true)
      }
    } finally {
      await s.close()
    }
  })
})
