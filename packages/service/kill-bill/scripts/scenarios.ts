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
  const raw = async (method: string, path: string, body?: unknown, contentType?: string) => {
    const response = await fetch(`${target.baseUrl}${path}`, {
      method,
      headers: {
        ...base,
        ...(path.startsWith("/1.0/kb/tenants") ? {} : tenantHeaders),
        ...(body === undefined ? {} : { "content-type": contentType ?? "application/json" }),
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
    async call(name, method, path, body, contentType) {
      const result = await raw(method, path, body, contentType)
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
    const ctd = sub.chargedThroughDate ?? ""
    await kb.call(
      "nothing due today",
      "POST",
      `/1.0/kb/invoices?accountId=${accountId}&targetDate=${ctd.slice(0, 10) === "" ? "" : todayOf(ctd, -1)}`,
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
    )
    await kb.call(
      "look the refund up by key",
      "GET",
      "/1.0/kb/paymentTransactions?transactionExternalKey=parity-refund-1&audit=FULL",
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
  await kb.call("set the clock", "POST", "/1.0/kb/test/clock?requestedDate=2030-01-01")
  const { accountId, subscriptionId } = await member(kb, MONTHLY)
  await kb.call(
    `move the billing day to ${day} from ${effective}`,
    "PUT",
    `/1.0/kb/subscriptions/${subscriptionId}/bcd?effectiveFromDate=${effective}`,
    { subscriptionId, billCycleDayLocal: day },
  )
  const read = async () => {
    const invoices = (
      await kb.raw("GET", `/1.0/kb/accounts/${accountId}/invoices?includeInvoiceComponents=true`)
    ).body as Array<{
      items?: Array<{ itemType: string; startDate: string; endDate: string; amount: number }>
    }>
    const sub = (await kb.raw("GET", `/1.0/kb/subscriptions/${subscriptionId}`)).body as {
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
  for (const date of days) {
    await kb.call(`clock ${date}`, "POST", `/1.0/kb/test/clock?requestedDate=${date}`)
    // Real Kill Bill can finish a clock move's invoicing just after its queues report idle: read
    // until two reads a few seconds apart agree.
    let state = await read()
    for (let attempt = 0; kb.settles && attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      const again = await read()
      if (JSON.stringify(again) === JSON.stringify(state)) break
      state = again
    }
    kb.steps.push({ name: `billing on ${date}`, status: 200, body: state })
  }
  await kb.call("reset the clock", "POST", "/1.0/kb/test/clock")
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

const ID_KEYS = /(Id|Key|Number|recordId|userToken)$/
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
          .filter(([k]) => k !== "auditLogs" && k !== "stackTrace")
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, walk(v, k)]),
      )
    if (typeof value === "string") {
      if (key.endsWith("Number") && value !== "") return id(value, key)
      if (UUID.test(value) || (ID_KEYS.test(key) && value !== "")) return id(value)
      if (TIMESTAMP.test(value)) return "<ts>"
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
