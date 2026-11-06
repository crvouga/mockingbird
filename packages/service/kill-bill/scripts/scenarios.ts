/**
 * Kill Bill parity scenarios: the same request sequences sent to a real Kill Bill and to the
 * emulator, each in a fresh tenant, and recorded as a normalized transcript to diff.
 */

export type Step = { name: string; status: number; body: unknown }
export type Transcript = { scenario: string; steps: Step[] }

export type Target = {
  baseUrl: string
  username: string
  password: string
  /** Real Kill Bill invoices and pays asynchronously; wait for its bus and notification queues. */
  drainQueues: boolean
}

const MONTHLY = "parity-monthly"
const ANNUAL = "parity-annual"

export const PARITY_CATALOG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<catalog xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="CatalogSchema.xsd">
  <effectiveDate>2024-01-01T00:00:00+00:00</effectiveDate>
  <catalogName>parity</catalogName>
  <recurringBillingMode>IN_ADVANCE</recurringBillingMode>
  <currencies><currency>USD</currency></currencies>
  <products>
    <product name="Monthly"><category>BASE</category></product>
    <product name="Annual"><category>BASE</category></product>
  </products>
  <rules>
    <changePolicy><changePolicyCase><policy>IMMEDIATE</policy></changePolicyCase></changePolicy>
    <changeAlignment><changeAlignmentCase><alignment>START_OF_SUBSCRIPTION</alignment></changeAlignmentCase></changeAlignment>
    <cancelPolicy><cancelPolicyCase><policy>END_OF_TERM</policy></cancelPolicyCase></cancelPolicy>
    <createAlignment><createAlignmentCase><alignment>START_OF_SUBSCRIPTION</alignment></createAlignmentCase></createAlignment>
    <billingAlignment><billingAlignmentCase><alignment>SUBSCRIPTION</alignment></billingAlignmentCase></billingAlignment>
    <priceList><priceListCase><toPriceList>DEFAULT</toPriceList></priceListCase></priceList>
  </rules>
  <plans>
    <plan name="${MONTHLY}">
      <product>Monthly</product>
      <finalPhase type="EVERGREEN">
        <duration><unit>UNLIMITED</unit></duration>
        <recurring>
          <billingPeriod>MONTHLY</billingPeriod>
          <recurringPrice><price><currency>USD</currency><value>100.00</value></price></recurringPrice>
        </recurring>
      </finalPhase>
    </plan>
    <plan name="${ANNUAL}">
      <product>Annual</product>
      <finalPhase type="EVERGREEN">
        <duration><unit>UNLIMITED</unit></duration>
        <recurring>
          <billingPeriod>ANNUAL</billingPeriod>
          <recurringPrice><price><currency>USD</currency><value>1200.00</value></price></recurringPrice>
        </recurring>
      </finalPhase>
    </plan>
  </plans>
  <priceLists><defaultPriceList name="DEFAULT"><plans><plan>${MONTHLY}</plan><plan>${ANNUAL}</plan></plans></defaultPriceList></priceLists>
</catalog>`

type Client = {
  /** True against a real Kill Bill, whose invoicing is asynchronous. */
  settles: boolean
  raw: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>
  call: (
    name: string,
    method: string,
    path: string,
    body?: unknown,
    contentType?: string,
    headers?: Record<string, string>,
  ) => Promise<Step>
  idFrom: (step: Step) => string
  drain: () => Promise<void>
  steps: Step[]
}

async function client(target: Target, scenario: string): Promise<Client> {
  const tenant = `parity-${scenario}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const base = {
    authorization: `Basic ${btoa(`${target.username}:${target.password}`)}`,
    "x-killbill-createdby": "mockingbird-parity",
  }
  const tenantHeaders = { "x-killbill-apikey": tenant, "x-killbill-apisecret": `${tenant}-secret` }
  const steps: Step[] = []
  const locations = new WeakMap<Step, string>()
  const raw = async (
    method: string,
    path: string,
    body?: unknown,
    contentType?: string,
    extra: Record<string, string> = {},
  ) => {
    const response = await fetch(`${target.baseUrl}${path}`, {
      method,
      headers: {
        ...base,
        ...(path.startsWith("/1.0/kb/tenants") ? {} : tenantHeaders),
        ...(body === undefined ? {} : { "content-type": contentType ?? "application/json" }),
        ...extra,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    })
    const text = await response.text()
    let parsed: unknown = text
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {}
    return {
      status: response.status,
      body: parsed,
      location: response.headers.get("location") ?? "",
    }
  }
  const created = await raw("POST", "/1.0/kb/tenants?useGlobalDefault=false", {
    apiKey: tenantHeaders["x-killbill-apikey"],
    apiSecret: tenantHeaders["x-killbill-apisecret"],
  })
  if (created.status !== 201) throw new Error(`tenant create failed: ${created.status}`)
  const drain = async () => {
    if (!target.drainQueues) return
    await raw("GET", "/1.0/kb/test/queues?timeoutSec=60")
  }
  return {
    settles: target.drainQueues,
    raw,
    steps,
    drain,
    async call(name, method, path, body, contentType, headers) {
      const result = await raw(method, path, body, contentType, headers)
      if (method !== "GET") await drain()
      const step = { name, status: result.status, body: result.body }
      locations.set(step, result.location)
      steps.push(step)
      return step
    },
    idFrom(step) {
      const id = locations.get(step)?.split("/").at(-1)?.split("?")[0]
      if (!id) throw new Error(`${step.name}: no Location (status ${step.status})`)
      return id
    },
  }
}

async function member(kb: Client, planName: string) {
  await kb.call("upload catalog", "POST", "/1.0/kb/catalog/xml", PARITY_CATALOG_XML, "text/xml")
  const account = await kb.call("create account", "POST", "/1.0/kb/accounts", {
    name: "Parity Member",
    currency: "USD",
    externalKey: `parity-${Math.random().toString(36).slice(2, 10)}`,
  })
  const accountId = kb.idFrom(account)
  const method = await kb.call(
    "add default external payment method",
    "POST",
    `/1.0/kb/accounts/${accountId}/paymentMethods?isDefault=true`,
    { pluginName: "__EXTERNAL_PAYMENT__" },
  )
  const paymentMethodId = kb.idFrom(method)
  const subscription = await kb.call("create subscription", "POST", "/1.0/kb/subscriptions", {
    accountId,
    planName,
  })
  return { accountId, paymentMethodId, subscriptionId: kb.idFrom(subscription) }
}

type Invoice = {
  invoiceId: string
  amount: number
  items?: Array<{ invoiceItemId: string; itemType: string }>
}
type Subscription = { chargedThroughDate?: string }

const SCENARIOS: Record<string, (kb: Client) => Promise<void>> = {
  /** Lookups of what does not exist: an external key, then account, subscription and invoice ids. */
  async "not-found"(kb) {
    await kb.call(
      "account by unknown external key",
      "GET",
      "/1.0/kb/accounts?externalKey=parity-nobody",
    )
    const id = "00000000-0000-0000-0000-000000000000"
    await kb.call("unknown account id", "GET", `/1.0/kb/accounts/${id}`)
    await kb.call("unknown subscription id", "GET", `/1.0/kb/subscriptions/${id}`)
    await kb.call("unknown invoice id", "GET", `/1.0/kb/invoices/${id}`)
  },
  /** A tenant with no catalog, then an uploaded catalog without the plan (backend catalog sync). */
  async "catalog-errors"(kb) {
    const account = await kb.call("create account", "POST", "/1.0/kb/accounts", {
      name: "Parity Member",
      currency: "USD",
    })
    const accountId = kb.idFrom(account)
    await kb.call("subscribe with no catalog", "POST", "/1.0/kb/subscriptions", {
      accountId,
      planName: MONTHLY,
    })
    await kb.call("upload catalog", "POST", "/1.0/kb/catalog/xml", PARITY_CATALOG_XML, "text/xml")
    await kb.call("subscribe to an unknown plan", "POST", "/1.0/kb/subscriptions", {
      accountId,
      planName: "parity-missing",
    })
  },
  /** e2e invoiceKillBillAccountThrough: bill the renewal on the day after the charged-through date. */
  async "invoice-renewal"(kb) {
    const { accountId, subscriptionId } = await member(kb, MONTHLY)
    const sub = (
      await kb.call("read subscription", "GET", `/1.0/kb/subscriptions/${subscriptionId}`)
    ).body as Subscription
    const ctd = sub.chargedThroughDate
    if (!ctd) throw new Error("invoice-renewal: the new subscription has no chargedThroughDate")
    await kb.call(
      "nothing due today",
      "POST",
      `/1.0/kb/invoices?accountId=${accountId}&targetDate=${todayOf(ctd, -1)}`,
    )
    await kb.call(
      "bill the renewal",
      "POST",
      `/1.0/kb/invoices?accountId=${accountId}&targetDate=${todayOf(ctd, 1)}`,
    )
    await kb.call(
      "bill it again",
      "POST",
      `/1.0/kb/invoices?accountId=${accountId}&targetDate=${todayOf(ctd, 1)}`,
    )
    await kb.call(
      "list invoices",
      "GET",
      `/1.0/kb/accounts/${accountId}/invoices?includeInvoiceComponents=true`,
    )
    await kb.call("read subscription after", "GET", `/1.0/kb/subscriptions/${subscriptionId}`)
  },
  /** Backend adjustInvoiceItem on a paid invoice: the adjustment becomes account credit. */
  async "item-adjust-paid"(kb) {
    const { accountId } = await member(kb, MONTHLY)
    const [invoice] = (
      await kb.call(
        "list invoices",
        "GET",
        `/1.0/kb/accounts/${accountId}/invoices?includeInvoiceComponents=true`,
      )
    ).body as Invoice[]
    const item = invoice?.items?.find((row) => row.itemType === "RECURRING")
    if (!invoice || !item) throw new Error("item-adjust-paid: no recurring item to adjust")
    await kb.call("adjust the paid item by 5", "POST", `/1.0/kb/invoices/${invoice.invoiceId}`, {
      accountId,
      invoiceItemId: item.invoiceItemId,
      amount: 5,
      currency: "USD",
    })
    await kb.call(
      "read the adjusted invoice",
      "GET",
      `/1.0/kb/invoices/${invoice.invoiceId}?includeInvoiceComponents=true`,
    )
    await kb.call(
      "read the account",
      "GET",
      `/1.0/kb/accounts/${accountId}?accountWithBalanceAndCBA=true`,
    )
  },
  /** A credit without autoCommit stays a DRAFT invoice until it is committed. */
  async "account-credit-draft"(kb) {
    const { accountId } = await member(kb, MONTHLY)
    await kb.call("add a draft credit", "POST", "/1.0/kb/credits", [
      { accountId, amount: 15, currency: "USD", description: "goodwill" },
    ])
    const account = `/1.0/kb/accounts/${accountId}?accountWithBalanceAndCBA=true`
    await kb.call("read the account", "GET", account)
    const invoices = (
      await kb.call(
        "list invoices",
        "GET",
        `/1.0/kb/accounts/${accountId}/invoices?includeInvoiceComponents=true`,
      )
    ).body as Array<Invoice & { status: string }>
    const draft = invoices.find((invoice) => invoice.status === "DRAFT")
    if (draft)
      await kb.call("commit it", "PUT", `/1.0/kb/invoices/${draft.invoiceId}/commitInvoice`)
    await kb.call("read the account after", "GET", account)
  },
  /** Invoicing ahead: a subscription that has not started yet, then a target years away. */
  async "invoice-target-dates"(kb) {
    await kb.call("upload catalog", "POST", "/1.0/kb/catalog/xml", PARITY_CATALOG_XML, "text/xml")
    const accountId = kb.idFrom(
      await kb.call("create account", "POST", "/1.0/kb/accounts", {
        name: "Parity Member",
        currency: "USD",
      }),
    )
    await kb.call(
      "add default external payment method",
      "POST",
      `/1.0/kb/accounts/${accountId}/paymentMethods?isDefault=true`,
      { pluginName: "__EXTERNAL_PAYMENT__" },
    )
    const today = todayOf(new Date().toISOString(), 0)
    const start = todayOf(today, 10)
    const subscriptionId = kb.idFrom(
      await kb.call(
        "subscribe from a later day",
        "POST",
        `/1.0/kb/subscriptions?entitlementDate=${start}&billingDate=${start}`,
        { accountId, planName: MONTHLY },
      ),
    )
    await kb.call(
      "invoice past the later start",
      "POST",
      `/1.0/kb/invoices?accountId=${accountId}&targetDate=${todayOf(start, 2)}`,
    )
    await kb.call(
      "read the invoiced subscription",
      "GET",
      `/1.0/kb/subscriptions/${subscriptionId}`,
    )
    // Kill Bill refuses a target 37 months or more ahead (4005), and more than 15 items for one
    // subscription in a day (the safety bound, code 4).
    const months = (count: number) => {
      const date = new Date(`${today}T00:00:00.000Z`)
      date.setUTCMonth(date.getUTCMonth() + count)
      return date.toISOString().slice(0, 10)
    }
    await kb.call(
      "preview 37 months ahead",
      "POST",
      `/1.0/kb/invoices/dryRun?accountId=${accountId}&targetDate=${months(37)}`,
      { dryRunType: "TARGET_DATE" },
    )
    await kb.call(
      "invoice 37 months ahead",
      "POST",
      `/1.0/kb/invoices?accountId=${accountId}&targetDate=${months(37)}`,
    )
    await kb.call(
      "invoice the day before 37 months ahead",
      "POST",
      `/1.0/kb/invoices?accountId=${accountId}&targetDate=${todayOf(months(37), -1)}`,
    )
    const invoices = (
      await kb.raw("GET", `/1.0/kb/accounts/${accountId}/invoices?includeInvoiceComponents=true`)
    ).body as Array<{ items?: Array<{ itemType: string; startDate: string; endDate: string }> }>
    const periods = invoices.flatMap((invoice) => invoice.items ?? [])
    kb.steps.push({
      name: "invoiced periods",
      status: 200,
      body: {
        count: periods.length,
        first: periods[0] ? `${periods[0].startDate}..${periods[0].endDate}` : null,
        last: periods.at(-1) ? `${periods.at(-1)?.startDate}..${periods.at(-1)?.endDate}` : null,
      },
    })
  },
  /** Backend addAccountCredit (POST /credits?autoCommit=true) and the next invoices using it. */
  async "account-credit"(kb) {
    const { accountId } = await member(kb, MONTHLY)
    for (const amount of [40, 250]) {
      await kb.call(`credit ${amount}`, "POST", "/1.0/kb/credits?autoCommit=true", [
        { accountId, amount, currency: "USD", description: `parity-credit-${amount}` },
      ])
      await kb.call(
        `read account after credit ${amount}`,
        "GET",
        `/1.0/kb/accounts/${accountId}?accountWithBalanceAndCBA=true`,
      )
      await kb.call(`subscribe again after credit ${amount}`, "POST", "/1.0/kb/subscriptions", {
        accountId,
        planName: MONTHLY,
      })
      await kb.call(
        `read account after subscribing ${amount}`,
        "GET",
        `/1.0/kb/accounts/${accountId}?accountWithBalanceAndCBA=true`,
      )
    }
    await kb.call(
      "list invoices",
      "GET",
      `/1.0/kb/accounts/${accountId}/invoices?includeInvoiceComponents=true`,
    )
  },
  /** Backend createSubscription with a later start (entitlementDate + billingDate), then a cancel. */
  async "future-start"(kb) {
    await kb.call("upload catalog", "POST", "/1.0/kb/catalog/xml", PARITY_CATALOG_XML, "text/xml")
    const accountId = kb.idFrom(
      await kb.call("create account", "POST", "/1.0/kb/accounts", {
        name: "Parity Member",
        currency: "USD",
      }),
    )
    await kb.call(
      "add default external payment method",
      "POST",
      `/1.0/kb/accounts/${accountId}/paymentMethods?isDefault=true`,
      {
        pluginName: "__EXTERNAL_PAYMENT__",
      },
    )
    const day = todayOf(new Date().toISOString(), 10)
    const created = await kb.call(
      "subscribe from a later day",
      "POST",
      `/1.0/kb/subscriptions?entitlementDate=${day}&billingDate=${day}`,
      { accountId, planName: MONTHLY },
    )
    const subscriptionId = kb.idFrom(created)
    await kb.call("read pending subscription", "GET", `/1.0/kb/subscriptions/${subscriptionId}`)
    await kb.call(
      "list invoices before start",
      "GET",
      `/1.0/kb/accounts/${accountId}/invoices?includeInvoiceComponents=true`,
    )
    await kb.call(
      "cancel before it starts",
      "DELETE",
      `/1.0/kb/subscriptions/${subscriptionId}?billingPolicy=IMMEDIATE`,
    )
    if (kb.settles) await new Promise((resolve) => setTimeout(resolve, 3000))
    await kb.drain()
    await kb.call("read cancelled subscription", "GET", `/1.0/kb/subscriptions/${subscriptionId}`)
  },
  /** Backend cancelSubscription: each cancel shape it sends, on its own member. */
  async "cancel-variants"(kb) {
    const today = todayOf(new Date().toISOString(), 0)
    const inTen = todayOf(new Date().toISOString(), 10)
    const variants: Array<[string, string]> = [
      ["end of term", "entitlementPolicy=END_OF_TERM&billingPolicy=END_OF_TERM"],
      ["billing end of term only", "billingPolicy=END_OF_TERM"],
      ["today, billing immediate", `requestedDate=${today}&billingPolicy=IMMEDIATE`],
      ["in ten days, billing immediate", `requestedDate=${inTen}&billingPolicy=IMMEDIATE`],
      [
        "in ten days, use requested date",
        `requestedDate=${inTen}&billingPolicy=IMMEDIATE&useRequestedDateForBilling=true`,
      ],
      ["now as an instant", "requestedDate=<now>&useRequestedDateForBilling=true"],
      ["immediate policies", "entitlementPolicy=IMMEDIATE&billingPolicy=IMMEDIATE"],
    ]
    for (const [name, query] of variants) {
      const { accountId, subscriptionId } = await member(kb, MONTHLY)
      // An instant must not precede the subscription's start, so it is taken after creating it.
      const sent = query.replace("<now>", new Date().toISOString())
      await kb.call(`cancel ${name}`, "DELETE", `/1.0/kb/subscriptions/${subscriptionId}?${sent}`)
      // Real Kill Bill applies a stop at "now" asynchronously: let it settle before reading.
      if (kb.settles) await new Promise((resolve) => setTimeout(resolve, 3000))
      await kb.drain()
      const sub = (await kb.raw("GET", `/1.0/kb/subscriptions/${subscriptionId}`)).body as Record<
        string,
        unknown
      > & {
        events?: Array<{ eventType: string; effectiveDate: string }>
      }
      const invoices = (
        await kb.raw("GET", `/1.0/kb/accounts/${accountId}/invoices?includeInvoiceComponents=true`)
      ).body as Array<{
        amount: number
        balance: number
        creditAdj: number
        items?: Array<{ itemType: string; amount: number; startDate: string; endDate: string }>
      }>
      const account = (
        await kb.raw("GET", `/1.0/kb/accounts/${accountId}?accountWithBalanceAndCBA=true`)
      ).body as Record<string, unknown>
      kb.steps.push({
        name: `after cancel ${name}`,
        status: 200,
        body: {
          state: sub.state,
          cancelledDate: sub.cancelledDate,
          billingEndDate: sub.billingEndDate,
          chargedThroughDate: sub.chargedThroughDate,
          events: (sub.events ?? []).map(
            (event) => `${event.eventType} ${String(event.effectiveDate).slice(0, 10)}`,
          ),
          invoices: invoices.map((invoice) => ({
            amount: invoice.amount,
            balance: invoice.balance,
            creditAdj: invoice.creditAdj,
            items: (invoice.items ?? []).map(
              (item) => `${item.itemType} ${item.startDate}..${item.endDate} ${item.amount}`,
            ),
          })),
          accountBalance: account.accountBalance,
          accountCBA: account.accountCBA,
        },
      })
    }
  },
  /** Backend refundInvoicePayment: an external refund with item adjustment, then the key lookup. */
  async "refund-adjusted"(kb) {
    const { accountId, paymentMethodId } = await member(kb, MONTHLY)
    const invoices = (
      await kb.call(
        "list invoices",
        "GET",
        `/1.0/kb/accounts/${accountId}/invoices?includeInvoiceComponents=true`,
      )
    ).body as Invoice[]
    const invoice = invoices.find((row) => row.amount > 0)
    const payments = (
      await kb.call(
        "list invoice payments",
        "GET",
        `/1.0/kb/invoices/${invoice?.invoiceId}/payments`,
      )
    ).body as Array<{ paymentId: string }>
    const paymentId = payments[0]?.paymentId ?? "missing"
    const item = invoice?.items?.find((row) => row.itemType === "RECURRING")
    await kb.call(
      "refund 40 with item adjustment",
      "POST",
      `/1.0/kb/invoicePayments/${paymentId}/refunds?externalPayment=true&paymentMethodId=${paymentMethodId}`,
      {
        amount: 40,
        currency: "USD",
        transactionExternalKey: "parity-refund-1",
        isAdjusted: true,
        adjustments: [{ invoiceItemId: item?.invoiceItemId, amount: 40 }],
      },
      undefined,
      { "x-request-id": crypto.randomUUID(), "x-killbill-comment": "parity refund" },
    )
    await kb.call(
      "look the refund up by key",
      "GET",
      "/1.0/kb/paymentTransactions?transactionExternalKey=parity-refund-1&audit=FULL",
    )
    await kb.call(
      "read invoice with audit",
      "GET",
      `/1.0/kb/invoices/${invoice?.invoiceId}?withItems=true&audit=FULL`,
    )
    await kb.call(
      "unknown key",
      "GET",
      "/1.0/kb/paymentTransactions?transactionExternalKey=parity-missing",
    )
    await kb.call("read invoice", "GET", `/1.0/kb/invoices/${invoice?.invoiceId}?withItems=true`)
    await kb.call("read invoice without items", "GET", `/1.0/kb/invoices/${invoice?.invoiceId}`)
    await kb.call(
      "read account balance",
      "GET",
      `/1.0/kb/accounts/${accountId}?accountWithBalanceAndCBA=true`,
    )
  },
  /** Backend blockSubscription / unblockSubscription (billing-console pause). */
  async "block-entitlement"(kb) {
    const { accountId, subscriptionId } = await member(kb, MONTHLY)
    await kb.call(
      "pause billing and entitlement",
      "POST",
      `/1.0/kb/subscriptions/${subscriptionId}/block`,
      {
        stateName: "billing-console-pause",
        service: "billing-console",
        isBlockChange: false,
        isBlockBilling: true,
        isBlockEntitlement: true,
      },
    )
    await kb.call("read paused subscription", "GET", `/1.0/kb/subscriptions/${subscriptionId}`)
    await kb.call("read paused bundles", "GET", `/1.0/kb/accounts/${accountId}/bundles`)
    await kb.call("resume", "POST", `/1.0/kb/subscriptions/${subscriptionId}/block`, {
      stateName: "billing-console-resume",
      service: "billing-console",
      isBlockChange: false,
      isBlockBilling: false,
      isBlockEntitlement: false,
    })
    await kb.call("read resumed subscription", "GET", `/1.0/kb/subscriptions/${subscriptionId}`)
  },
  /** A billing-only pause across two renewals, resumed mid-period: what the paused months bill. */
  "billing-pause-resume": (kb) => {
    const block = (name: string, isBlockBilling: boolean) => async (subject: Member) => {
      await kb.call(name, "POST", `/1.0/kb/subscriptions/${subject.subscriptionId}/block`, {
        stateName: isBlockBilling ? "billing-console-pause" : "billing-console-resume",
        service: "billing-console",
        isBlockChange: false,
        isBlockBilling,
        isBlockEntitlement: false,
      })
    }
    // Pause and resume at midday: at midnight the clock is still before the account's reference
    // time, so real Kill Bill would apply the change only at the next clock move.
    return billingOverTime(kb, MONTHLY, [
      "2030-01-15T12:00:00Z",
      block("pause billing", true),
      "2030-02-01",
      "2030-03-01",
      "2030-03-10T12:00:00Z",
      block("resume billing", false),
      "2030-03-11",
      "2030-04-01",
    ])
  },
  /** Monthly renewals and a BCD change under the test clock (calendar months, prorated stub). */
  "bcd-5-from-february": (kb) =>
    bcdClock(kb, 5, "2030-02-01", [
      "2030-01-31",
      "2030-02-01",
      "2030-02-05",
      "2030-03-04",
      "2030-03-05",
    ]),
  /** A BCD set on the start day bills its stub on the first new billing day. */
  "bcd-5-from-start": (kb) =>
    bcdClock(kb, 5, "2030-01-01", ["2030-01-04", "2030-01-05", "2030-01-31", "2030-02-05"]),
  /** BCD 31 clamps to February's last day and returns to the 31st. */
  "bcd-31-month-ends": (kb) =>
    bcdClock(kb, 31, "2030-01-01", ["2030-01-31", "2030-02-01", "2030-02-28", "2030-03-31"]),
  /** Backend updateSubscriptionBCD on an annual plan. */
  async "bcd-annual"(kb) {
    const { subscriptionId } = await member(kb, ANNUAL)
    const sub = (
      await kb.call("read subscription", "GET", `/1.0/kb/subscriptions/${subscriptionId}`)
    ).body as Subscription & { billCycleDayLocal?: number }
    const day = ((sub.billCycleDayLocal ?? 1) % 28) + 1
    await kb.call(
      "move the billing day",
      "PUT",
      `/1.0/kb/subscriptions/${subscriptionId}/bcd?effectiveFromDate=${todayOf(new Date().toISOString(), 0)}`,
      { subscriptionId, billCycleDayLocal: day },
    )
    await kb.call("read subscription after", "GET", `/1.0/kb/subscriptions/${subscriptionId}`)
  },
}

async function bcdClock(kb: Client, day: number, effective: string, days: string[]) {
  await billingOverTime(kb, MONTHLY, days, async ({ subscriptionId }) => {
    await kb.call(
      `move the billing day to ${day} from ${effective}`,
      "PUT",
      `/1.0/kb/subscriptions/${subscriptionId}/bcd?effectiveFromDate=${effective}`,
      { subscriptionId, billCycleDayLocal: day },
    )
  })
}

type Member = Awaited<ReturnType<typeof member>>
type Moment = string | ((member: Member) => Promise<void>)

/**
 * Starts a member on 2030-01-01 under the test clock, runs `setup`, then walks `moments`: a date
 * moves the clock and records the billing so far; a function runs a request at the current clock.
 * The test clock is global to the Kill Bill server, so it is reset however the walk ends.
 */
async function billingOverTime(
  kb: Client,
  planName: string,
  moments: Moment[],
  setup: (member: Member) => Promise<void> = async () => {},
) {
  await kb.call("set the clock", "POST", "/1.0/kb/test/clock?requestedDate=2030-01-01")
  try {
    const subject = await member(kb, planName)
    await setup(subject)
    const read = async () => {
      const invoices = (
        await kb.raw(
          "GET",
          `/1.0/kb/accounts/${subject.accountId}/invoices?includeInvoiceComponents=true`,
        )
      ).body as Array<{
        items?: Array<{ itemType: string; startDate: string; endDate: string; amount: number }>
      }>
      const sub = (await kb.raw("GET", `/1.0/kb/subscriptions/${subject.subscriptionId}`)).body as {
        chargedThroughDate?: string
        billCycleDayLocal?: number
      }
      return {
        periods: invoices
          .flatMap((invoice) =>
            (invoice.items ?? []).map(
              (item) => `${item.itemType} ${item.startDate}..${item.endDate} ${item.amount}`,
            ),
          )
          .sort(),
        chargedThroughDate: sub.chargedThroughDate,
        billCycleDayLocal: sub.billCycleDayLocal,
      }
    }
    for (const moment of moments) {
      if (typeof moment !== "string") {
        await moment(subject)
        continue
      }
      await kb.call(`clock ${moment}`, "POST", `/1.0/kb/test/clock?requestedDate=${moment}`)
      // Real Kill Bill can finish a clock move's invoicing just after its queues report idle: read
      // until two reads a few seconds apart agree.
      let state = await read()
      for (let attempt = 0; kb.settles && attempt < 5; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000))
        const again = await read()
        if (JSON.stringify(again) === JSON.stringify(state)) break
        state = again
      }
      kb.steps.push({ name: `billing on ${moment}`, status: 200, body: state })
    }
  } finally {
    await kb.call("reset the clock", "POST", "/1.0/kb/test/clock")
  }
}

function todayOf(iso: string, plusDays: number) {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + plusDays)
  return date.toISOString().slice(0, 10)
}

export const SCENARIO_NAMES = Object.keys(SCENARIOS)

export async function runScenario(target: Target, scenario: string): Promise<Transcript> {
  const run = SCENARIOS[scenario]
  if (!run) throw new Error(`unknown scenario ${scenario}`)
  const kb = await client(target, scenario)
  await run(kb)
  return { scenario, steps: kb.steps }
}

const ID_KEYS = /(Id|Key|Number|userToken)$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

/** Ids become ordinal placeholders and timestamps become <ts>; dates, amounts and states stay. */
export function normalize(transcript: Transcript): Transcript {
  const ids = new Map<string, string>()
  // Invoice and payment numbers are separate counters; give each kind its own placeholders.
  const id = (value: string, kind = "id") => {
    const slot = `${kind}:${value}`
    if (!ids.has(slot))
      ids.set(
        slot,
        `<${kind}${[...ids.keys()].filter((key) => key.startsWith(`${kind}:`)).length + 1}>`,
      )
    return ids.get(slot) as string
  }
  const walk = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map((entry) => walk(entry, key))
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([k]) => k !== "stackTrace")
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, walk(v, k)]),
      )
    if (typeof value === "string") {
      if (key.endsWith("Number") && value !== "") return id(value, key)
      if (UUID.test(value) || (ID_KEYS.test(key) && value !== "")) return id(value)
      if (TIMESTAMP.test(value)) return "<ts>"
      if (value.startsWith("Invalid catalog for tenant : "))
        return "Invalid catalog for tenant : <n>"
      // The safety bound's message prints the subscription id and Kill Bill's whole item.
      if (value.startsWith("SAFETY BOUND TRIGGERED ")) return "SAFETY BOUND TRIGGERED <item>"
      if (value.startsWith("No existing versions in the VersionedCatalog catalog for input date "))
        return "No existing versions in the VersionedCatalog catalog for input date <date>"
      return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) =>
        id(m),
      )
    }
    return value
  }
  return {
    scenario: transcript.scenario,
    steps: transcript.steps.map((step) => walk(step) as Step),
  }
}
