import { describe, expect, test } from "bun:test"
import { createServer } from "./src/server.js"

// Kill Bill 0.24.10 (API 0.54.0) oracle responses from issues #643–#647, clock 2026-11-05, with
// the catalog below: no <billingAlignment> rule, so Kill Bill's default ACCOUNT alignment.
const headers = {
  authorization: `Basic ${btoa("admin:password")}`,
  "x-killbill-apikey": "bob",
  "x-killbill-apisecret": "lazar",
  "x-killbill-createdby": "billing-alignment-test",
}
const AUTO_PAY_OFF = "00000000-0000-0000-0000-000000000001"
const plan = (name: string, period: string, price: string) =>
  `<plan name="${name}"><product>Membership</product><initialPhases/><finalPhase type="EVERGREEN"><duration><unit>UNLIMITED</unit></duration><recurring><billingPeriod>${period}</billingPeriod><recurringPrice><price><currency>USD</currency><value>${price}</value></price></recurringPrice></recurring></finalPhase></plan>`
const catalog = (rules = "") =>
  `<?xml version="1.0" encoding="UTF-8"?><catalog><effectiveDate>2020-01-01T00:00:00+00:00</effectiveDate><catalogName>repro</catalogName><recurringBillingMode>IN_ADVANCE</recurringBillingMode><currencies><currency>USD</currency></currencies><products><product name="Membership"><category>BASE</category></product></products><rules><changePolicy><changePolicyCase><policy>END_OF_TERM</policy></changePolicyCase></changePolicy><cancelPolicy><cancelPolicyCase><policy>END_OF_TERM</policy></cancelPolicyCase></cancelPolicy>${rules}</rules><plans>${plan("repro-monthly", "MONTHLY", "100.00")}${plan("repro-annual", "ANNUAL", "1500.00")}</plans><priceLists><defaultPriceList name="DEFAULT"><plans><plan>repro-monthly</plan><plan>repro-annual</plan></plans></defaultPriceList></priceLists></catalog>`

type Item = { itemType: string; amount: number; startDate: string; endDate: string | null }
type InvoiceRow = { amount: number; balance: number; items: Item[] }
type InvoiceSummary = { amount: number; balance: number; items: string[] }

const session = async (rules = "") => {
  const received: string[] = []
  const sink = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const event = (await request.json()) as { eventType: string; objectType: string }
      received.push(`${event.eventType} ${event.objectType}`)
      return new Response(null, { status: 204 })
    },
  })
  const server = await createServer({ notificationDelayMs: 0 })
  const call = async (path: string, method = "GET", body?: unknown, contentType?: string) => {
    const res = await fetch(`${server.url}/1.0/kb${path}`, {
      method,
      headers: { ...headers, "content-type": contentType ?? "application/json" },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    })
    const text = await res.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {}
    return { status: res.status, json, id: (res.headers.get("location") ?? "").split("/").pop() }
  }
  /** Every push notification sent since the last call, once the queues have drained. */
  const events = async () => {
    await call("/test/queues?timeoutSec=10")
    return received.splice(0)
  }
  await call(
    `/tenants/registerNotificationCallback?cb=${encodeURIComponent(sink.url.toString())}`,
    "POST",
  )
  await call("/test/clock?requestedDate=2026-11-05", "POST")
  await call("/catalog/xml", "POST", catalog(rules), "text/xml")
  const newAccount = async (extra: Record<string, unknown> = {}) => {
    const { id } = await call("/accounts", "POST", {
      name: "Jane Doe",
      externalKey: `ext-${crypto.randomUUID()}`,
      currency: "USD",
      timeZone: "UTC",
      ...extra,
    })
    await call(`/accounts/${id}/tags`, "POST", [AUTO_PAY_OFF])
    return id as string
  }
  const subscribe = async (body: Record<string, unknown>, query = "") =>
    (await call(`/subscriptions?callCompletion=true&callTimeoutSec=10${query}`, "POST", body))
      .id as string
  const subscription = async (id: string) =>
    (await call(`/subscriptions/${id}`)).json as Record<string, unknown>
  const invoices = async (accountId: string) =>
    (
      (await call(`/accounts/${accountId}/invoices?withItems=true&includeInvoiceComponents=true`))
        .json as InvoiceRow[]
    ).map((i) => ({
      amount: i.amount,
      balance: i.balance,
      items: i.items.map((x) => `${x.itemType} ${x.amount} ${x.startDate}..${x.endDate ?? ""}`),
    }))
  const balances = async (accountId: string) => {
    const a = (await call(`/accounts/${accountId}?accountWithBalanceAndCBA=true`)).json as Record<
      string,
      unknown
    >
    return {
      accountBalance: a.accountBalance,
      accountCBA: a.accountCBA,
      billCycleDayLocal: a.billCycleDayLocal,
    }
  }
  const close = async () => {
    await server.close()
    sink.stop(true)
  }
  return { close, events, call, newAccount, subscribe, subscription, invoices, balances }
}

describe("Kill Bill ACCOUNT billing alignment (Kill Bill 0.24.10, issues #643–#645)", () => {
  test("#643: an account BCD prorates a later subscription's first period to it", async () => {
    const s = await session()
    try {
      const accountId = await s.newAccount({ billCycleDayLocal: 20 })
      expect((await s.balances(accountId)).billCycleDayLocal).toBe(20)
      const id = await s.subscribe({ accountId, planName: "repro-annual" })
      const sub = await s.subscription(id)
      expect({
        billCycleDayLocal: sub.billCycleDayLocal,
        chargedThroughDate: sub.chargedThroughDate,
      }).toEqual({ billCycleDayLocal: 20, chargedThroughDate: "2026-11-20" })
      expect(await s.invoices(accountId)).toEqual([
        { amount: 61.64, balance: 61.64, items: ["RECURRING 61.64 2026-11-05..2026-11-20"] },
      ])
      // The next period is a full year from the account's day.
      await s.call("/test/clock?requestedDate=2026-11-20", "POST")
      expect((await s.invoices(accountId)).at(-1)?.items).toEqual([
        "RECURRING 1500 2026-11-20..2027-11-20",
      ])
      expect((await s.subscription(id)).chargedThroughDate).toBe("2027-11-20")
    } finally {
      await s.close()
    }
  })

  test("#643: a first subscription sets the account BCD and emits ACCOUNT_CHANGE", async () => {
    const s = await session()
    try {
      const accountId = await s.newAccount()
      expect((await s.balances(accountId)).billCycleDayLocal).toBe(0)
      await s.events()
      await s.subscribe({ accountId, planName: "repro-monthly" })
      const created = await s.events()
      expect(await s.balances(accountId)).toEqual({
        accountBalance: 100,
        accountCBA: 0,
        billCycleDayLocal: 5,
      })
      expect(created).toContain("ACCOUNT_CHANGE ACCOUNT")
      expect(created.indexOf("ACCOUNT_CHANGE ACCOUNT")).toBeLessThan(
        created.indexOf("INVOICE_CREATION INVOICE"),
      )
      expect(await s.invoices(accountId)).toEqual([
        { amount: 100, balance: 100, items: ["RECURRING 100 2026-11-05..2026-12-05"] },
      ])
      // A second subscription on another day is billed to the account's day 5.
      await s.call("/test/clock?requestedDate=2026-11-10", "POST")
      const second = await s.subscribe({ accountId, planName: "repro-annual" })
      expect(await s.subscription(second)).toMatchObject({
        billCycleDayLocal: 5,
        chargedThroughDate: "2027-11-05",
      })
      expect((await s.invoices(accountId)).at(-1)?.items).toEqual([
        "RECURRING 1479.45 2026-11-10..2027-11-05",
      ])
    } finally {
      await s.close()
    }
  })

  test("#643: a subscription-level billCycleDayLocal overrides the account BCD", async () => {
    const s = await session()
    try {
      const accountId = await s.newAccount({ billCycleDayLocal: 20 })
      const id = await s.subscribe({ accountId, planName: "repro-annual", billCycleDayLocal: 5 })
      expect(await s.subscription(id)).toMatchObject({
        billCycleDayLocal: 5,
        chargedThroughDate: "2027-11-05",
      })
      expect(await s.invoices(accountId)).toEqual([
        { amount: 1500, balance: 1500, items: ["RECURRING 1500 2026-11-05..2027-11-05"] },
      ])
    } finally {
      await s.close()
    }
  })

  test("#643: a SUBSCRIPTION billing alignment ignores the account BCD", async () => {
    const s = await session(
      "<billingAlignment><billingAlignmentCase><alignment>SUBSCRIPTION</alignment></billingAlignmentCase></billingAlignment>",
    )
    try {
      const accountId = await s.newAccount({ billCycleDayLocal: 20 })
      const id = await s.subscribe({ accountId, planName: "repro-annual" })
      expect((await s.subscription(id)).chargedThroughDate).toBe("2027-11-05")
    } finally {
      await s.close()
    }
  })

  test("#644: billCycleDayLocal on an ANNUAL subscription keeps a one-year term", async () => {
    const s = await session()
    try {
      const accountId = await s.newAccount()
      const id = await s.subscribe({ accountId, planName: "repro-annual", billCycleDayLocal: 5 })
      expect(await s.subscription(id)).toMatchObject({
        planName: "repro-annual",
        billCycleDayLocal: 5,
        chargedThroughDate: "2027-11-05",
      })
      const first = [
        { amount: 1500, balance: 1500, items: ["RECURRING 1500 2026-11-05..2027-11-05"] },
      ]
      expect(await s.invoices(accountId)).toEqual(first)
      await s.call("/test/clock?requestedDate=2026-12-06", "POST")
      expect(await s.invoices(accountId)).toEqual(first)
      await s.call("/test/clock?requestedDate=2027-11-06", "POST")
      expect((await s.invoices(accountId)).at(-1)?.items).toEqual([
        "RECURRING 1500 2027-11-05..2028-11-05",
      ])
    } finally {
      await s.close()
    }
  })

  test("#645: a past billingDate starts the first period on it", async () => {
    const s = await session()
    try {
      const accountId = await s.newAccount()
      const id = await s.subscribe(
        { accountId, planName: "repro-monthly" },
        "&entitlementDate=2026-10-20&billingDate=2026-10-20",
      )
      const sub = await s.subscription(id)
      expect({
        startDate: String(sub.startDate).slice(0, 10),
        chargedThroughDate: sub.chargedThroughDate,
        billCycleDayLocal: sub.billCycleDayLocal,
      }).toEqual({
        startDate: "2026-10-20",
        chargedThroughDate: "2026-11-20",
        billCycleDayLocal: 20,
      })
      expect(await s.invoices(accountId)).toEqual([
        { amount: 100, balance: 100, items: ["RECURRING 100 2026-10-20..2026-11-20"] },
      ])
      expect((await s.balances(accountId)).billCycleDayLocal).toBe(20)
    } finally {
      await s.close()
    }
  })
})

describe("Kill Bill account credit and repairs (Kill Bill 0.24.10, issues #646–#647)", () => {
  test("#646: account credit pays later invoices", async () => {
    const s = await session()
    try {
      for (const [credit, after] of [
        [
          2000,
          {
            invoice: {
              amount: 100,
              balance: 0,
              items: [
                "RECURRING 100 2026-11-05..2026-12-05",
                "CBA_ADJ -100 2026-11-05..2026-11-05",
              ],
            },
            account: { accountBalance: -1900, accountCBA: 1900, billCycleDayLocal: 5 },
          },
        ],
        [
          40,
          {
            invoice: {
              amount: 100,
              balance: 60,
              items: ["RECURRING 100 2026-11-05..2026-12-05", "CBA_ADJ -40 2026-11-05..2026-11-05"],
            },
            account: { accountBalance: 60, accountCBA: 0, billCycleDayLocal: 5 },
          },
        ],
      ] as Array<
        [
          number,
          {
            invoice: InvoiceSummary
            account: { accountBalance: number; accountCBA: number; billCycleDayLocal: number }
          },
        ]
      >) {
        const accountId = await s.newAccount()
        const created = await s.call("/credits?autoCommit=true", "POST", [
          { accountId, amount: credit, currency: "USD", description: "goodwill" },
        ])
        expect(created.status).toBe(200)
        expect(created.json).toMatchObject([{ itemType: "CREDIT_ADJ", amount: credit }])
        const [row] = created.json as Array<{ invoiceId?: string; invoiceItemId?: string }>
        expect(row?.invoiceId).toBeString()
        expect(row?.invoiceItemId).toBeString()
        expect(await s.balances(accountId)).toEqual({
          accountBalance: -credit,
          accountCBA: credit,
          billCycleDayLocal: 0,
        })
        await s.events()
        await s.subscribe({ accountId, planName: "repro-monthly" })
        const events = await s.events()
        expect(await s.invoices(accountId)).toEqual([
          {
            amount: 0,
            balance: 0,
            items: [
              `CREDIT_ADJ -${credit} 2026-11-05..2026-11-05`,
              `CBA_ADJ ${credit} 2026-11-05..2026-11-05`,
            ],
          },
          after.invoice,
        ])
        expect(await s.balances(accountId)).toEqual(after.account)
        expect(events).toContain("INVOICE_CREATION INVOICE")
        // AUTO_PAY_OFF: nothing is paid, so no payment events either way.
        expect(events.filter((event) => event.includes("PAYMENT"))).toEqual([])
      }
    } finally {
      await s.close()
    }
  })

  test("#646: a fully covered invoice is not paid even with a default payment method", async () => {
    const s = await session()
    try {
      const { id: accountId } = await s.call("/accounts", "POST", { currency: "USD" })
      await s.call(`/accounts/${accountId}/paymentMethods?isDefault=true`, "POST", {
        pluginName: "__EXTERNAL_PAYMENT__",
      })
      await s.call("/credits?autoCommit=true", "POST", [{ accountId, amount: 2000 }])
      await s.events()
      await s.subscribe({ accountId, planName: "repro-monthly" })
      const events = await s.events()
      expect(events).toContain("INVOICE_CREATION INVOICE")
      expect(events.filter((event) => event.includes("PAYMENT"))).toEqual([])
    } finally {
      await s.close()
    }
  })

  test("#647: an IMMEDIATE cancel repairs the invoice and returns the credit", async () => {
    const s = await session()
    try {
      const accountId = await s.newAccount()
      await s.call("/credits?autoCommit=true", "POST", [
        { accountId, amount: 40, currency: "USD", description: "goodwill" },
      ])
      const id = await s.subscribe({ accountId, planName: "repro-monthly" })
      await s.events()
      const cancel = await s.call(
        `/subscriptions/${id}?entitlementPolicy=IMMEDIATE&billingPolicy=IMMEDIATE&callCompletion=true&callTimeoutSec=10`,
        "DELETE",
      )
      expect(cancel.status).toBe(204)
      expect(await s.invoices(accountId)).toEqual([
        {
          amount: 0,
          balance: 0,
          items: ["CREDIT_ADJ -40 2026-11-05..2026-11-05", "CBA_ADJ 40 2026-11-05..2026-11-05"],
        },
        {
          amount: 100,
          balance: 0,
          items: [
            "RECURRING 100 2026-11-05..2026-12-05",
            "CBA_ADJ -40 2026-11-05..2026-11-05",
            "CBA_ADJ -60 2026-11-05..2026-11-05",
          ],
        },
        {
          amount: -100,
          balance: 0,
          items: ["REPAIR_ADJ -100 2026-11-05..2026-12-05", "CBA_ADJ 100 2026-11-05..2026-11-05"],
        },
      ])
      expect(await s.balances(accountId)).toEqual({
        accountBalance: -40,
        accountCBA: 40,
        billCycleDayLocal: 5,
      })
      const items = (
        (await s.call(`/accounts/${accountId}/invoices?includeInvoiceComponents=true`))
          .json as Array<{
          items: Array<Item & { invoiceItemId: string; linkedInvoiceItemId: string | null }>
        }>
      ).flatMap((invoice) => invoice.items)
      const recurring = items.find((item) => item.itemType === "RECURRING")
      expect(items.find((item) => item.itemType === "REPAIR_ADJ")?.linkedInvoiceItemId).toBe(
        recurring?.invoiceItemId as string,
      )
      const events = await s.events()
      expect(events).toContain("INVOICE_CREATION INVOICE")
      expect(events).toContain("INVOICE_ADJUSTMENT INVOICE")
    } finally {
      await s.close()
    }
  })

  test("#647: an IMMEDIATE plan change invoices the new plan and repairs the old one", async () => {
    const s = await session()
    try {
      const accountId = await s.newAccount()
      const id = await s.subscribe({ accountId, planName: "repro-monthly" })
      const change = await s.call(
        `/subscriptions/${id}?billingPolicy=IMMEDIATE&callCompletion=true&callTimeoutSec=10`,
        "PUT",
        { planName: "repro-annual" },
      )
      expect(change.status).toBe(204)
      expect(await s.invoices(accountId)).toEqual([
        { amount: 100, balance: 100, items: ["RECURRING 100 2026-11-05..2026-12-05"] },
        {
          amount: 1400,
          balance: 1400,
          items: [
            "RECURRING 1500 2026-11-05..2027-11-05",
            "REPAIR_ADJ -100 2026-11-05..2026-12-05",
          ],
        },
      ])
      expect(await s.balances(accountId)).toEqual({
        accountBalance: 1500,
        accountCBA: 0,
        billCycleDayLocal: 5,
      })
    } finally {
      await s.close()
    }
  })
})
