import { type APIOptions, bootSqlite } from "@crvouga/mockingbird-service"
import { clearNamespace } from "@crvouga/mockingbird-sqlite"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
import {
  type Account,
  type AuditStamp,
  type CatalogPlan,
  type Invoice,
  type InvoiceItem,
  KillBillState,
  type Payment,
  type PaymentMethod,
  type Subscription,
  type Tenant,
  type Transaction,
} from "./state.js"

export type { KillBillRuntime, KillBillRuntimeOptions } from "./runtime.js"
export { createRuntime, KILL_BILL_PRESETS } from "./runtime.js"
export type {
  Account,
  Audit,
  Bundle,
  CatalogPlan,
  Invoice,
  InvoiceItem,
  Payment,
  PaymentMethod,
  QueuedBusEvent,
  QueuedNotification,
  Subscription,
  Tenant,
  Transaction,
} from "./state.js"
export { document, operationIds, supportedOperationIds }
export const KILL_BILL_NAMESPACE = "kill-bill"
type Input = Record<string, unknown>
export type KillBillEvent = {
  eventType: string
  objectType: string
  objectId: string
  accountId?: string
  sequence: number
  effectiveDate: string
}
export type KillBillAPIOptions = APIOptions & {
  adminPrefix?: string
  username?: string
  password?: string
  tenantKey?: string
  tenantSecret?: string
  plans?: readonly CatalogPlan[]
  /** Delay before a push notification is delivered (Kill Bill's bus took 2–3 s). Default 2000. */
  notificationDelayMs?: number
  onEvent?: (event: KillBillEvent) => void
}
const DEFAULT_TENANT_ID = "tenant-default"
type RequestAudit = AuditStamp & { level: "NONE" | "MINIMAL" | "FULL" }
const TOMCAT_404 =
  '<!doctype html><html lang="en"><head><title>HTTP Status 404 – Not Found</title><style type="text/css">body {font-family:Tahoma,Arial,sans-serif;} h1, h2, h3, b {color:white;background-color:#525D76;} h1 {font-size:22px;} h2 {font-size:16px;} h3 {font-size:14px;} p {font-size:12px;} a {color:black;} .line {height:1px;background-color:#525D76;border:none;}</style></head><body><h1>HTTP Status 404 – Not Found</h1><hr class="line" /><p><b>Type</b> Status Report</p><p><b>Message</b> Not Found</p><p><b>Description</b> The origin server did not find a current representation for the target resource or is not willing to disclose that one exists.</p><hr class="line" /><h3>Apache Tomcat/9.0.98</h3></body></html>'
const NOTIFICATION_KEY = "PUSH_NOTIFICATION_CB"
/**
 * Kill Bill 0.24.16 retries a push notification its callback refused 15 minutes, 30 minutes,
 * 2 hours and 12 hours after each failed attempt (measured with the test clock), then a day.
 */
const NOTIFICATION_RETRY_MS = [15, 30, 120, 720, 1440].map((minutes) => minutes * 60_000)
const PUSH_RETRY = "PUSH_NOTIFICATION_RETRY"
/** Kill Bill's default org.killbill.invoice.maxDailyNumberOfItemsSafetyBound. */
const SAFETY_BOUND = 15
// Kill Bill's built-in AUTO_PAY_OFF control tag definition.
const AUTO_PAY_OFF_TAG_ID = "00000000-0000-0000-0000-000000000001"
const money = (value: unknown) => Math.round((Number(value) + Number.EPSILON) * 100) / 100
const object = (value: unknown): Input =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Input) : {}
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)
/** The next period start: calendar months for month-based plans, years for annual ones. */
const addPeriod = (date: string, intervalDays = 30) => {
  const start = new Date(`${date}T00:00:00.000Z`)
  const months =
    intervalDays >= 365
      ? 12 * Math.round(intervalDays / 365)
      : intervalDays % 30 === 0
        ? intervalDays / 30
        : 0
  if (months === 0) return isoDate(start.getTime() + intervalDays * 86_400_000)
  const target = start.getUTCMonth() + months
  const last = new Date(Date.UTC(start.getUTCFullYear(), target + 1, 0)).getUTCDate()
  return isoDate(Date.UTC(start.getUTCFullYear(), target, Math.min(start.getUTCDate(), last)))
}
const billingPeriod = (intervalDays?: number) => {
  if (intervalDays === 1) return "DAILY"
  if (intervalDays === 7) return "WEEKLY"
  if (intervalDays !== undefined && intervalDays >= 365) return "ANNUAL"
  return "MONTHLY"
}
// Mock billing advances by intervalDays, so month-based periods use a 30-day month.
const billingPeriodDays: Record<string, number> = {
  DAILY: 1,
  WEEKLY: 7,
  BIWEEKLY: 14,
  THIRTY_DAYS: 30,
  THIRTY_ONE_DAYS: 31,
  SIXTY_DAYS: 60,
  NINETY_DAYS: 90,
  MONTHLY: 30,
  BIMESTRIAL: 60,
  QUARTERLY: 90,
  TRIANNUAL: 120,
  BIANNUAL: 180,
  ANNUAL: 365,
  SESQUIENNIAL: 540,
  BIENNIAL: 730,
  TRIENNIAL: 1095,
}
const recurringPrice = (phase: string): { amount: number; currency?: string } => {
  const blocks = [...phase.matchAll(/<recurringPrice>\s*([\s\S]*?)\s*<\/recurringPrice>/gi)]
  const block = blocks.at(-1)?.[1] ?? ""
  const prices = [...block.matchAll(/<price>\s*([\s\S]*?)\s*<\/price>/gi)].flatMap((match) => {
    const inner = match[1] ?? ""
    const value = /<value>\s*([\d.]+)\s*<\/value>/i.exec(inner)?.[1]
    if (value === undefined) return []
    const currency = /<currency>\s*([A-Za-z]+)\s*<\/currency>/i.exec(inner)?.[1]?.toUpperCase()
    return [{ amount: money(value), ...(currency ? { currency } : {}) }]
  })
  // CatalogPlan stores one price. Prefer USD, then the first price in the final phase.
  return prices.find((price) => price.currency === "USD") ?? prices[0] ?? { amount: 0 }
}
const catalogPlans = (xml: string): CatalogPlan[] => {
  const plans: CatalogPlan[] = []
  for (const match of xml.matchAll(/<plan\b([^>]*)>/gi)) {
    const attrs = match[1] ?? ""
    const name = /\bname=["']([^"']+)["']/.exec(attrs)?.[1]
    if (!name) continue
    const selfClosing = /\/\s*$/.test(attrs)
    const start = (match.index ?? 0) + match[0].length
    const end = selfClosing ? start : xml.indexOf("</plan>", start)
    const body = selfClosing || end === -1 ? "" : xml.slice(start, end)
    const phase = /<finalPhase\b[^>]*>([\s\S]*?)<\/finalPhase>/i.exec(body)?.[1] ?? body
    const amountAttr = /\bamount=["']([\d.]+)["']/.exec(attrs)?.[1]
    const priced: { amount: number; currency?: string } =
      amountAttr === undefined ? recurringPrice(phase) : { amount: money(amountAttr) }
    const period = /<billingPeriod>\s*([A-Za-z0-9_]+)\s*<\/billingPeriod>/i.exec(phase)?.[1]
    const intervalDays = period ? billingPeriodDays[period.toUpperCase()] : undefined
    const product = /<product>\s*([^<]+?)\s*<\/product>/i.exec(body)?.[1]
    plans.push({
      name,
      ...(product ? { product } : {}),
      amount: priced.amount,
      ...(priced.currency ? { currency: priced.currency } : {}),
      ...(intervalDays !== undefined ? { intervalDays } : {}),
    })
  }
  return plans
}
const JAVA_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const JAVA_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]
// java.util.Date#toString in GMT, as Kill Bill prints the catalog input date: "Thu Nov 05 22:29:00 GMT 2026".
const javaDate = (ms: number) => {
  const date = new Date(ms)
  const two = (n: number) => String(n).padStart(2, "0")
  return `${JAVA_DAYS[date.getUTCDay()]} ${JAVA_MONTHS[date.getUTCMonth()]} ${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} GMT ${date.getUTCFullYear()}`
}
const FIXED_OFFSET = /^([+-])(\d{2}):(\d{2})$/
// Kill Bill 0.24 DateTimeZone.forID: omitted means UTC; otherwise a fixed offset or an IANA id.
const clockZone = (raw: string | null) => {
  if (raw == null || raw === "UTC") return "UTC"
  if (/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/.test(raw)) return raw
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw }).format(0)
    return raw
  } catch {
    return undefined
  }
}
const localDateInZone = (ms: number, timeZone: string) => {
  const offset = FIXED_OFFSET.exec(timeZone)
  if (offset) {
    const sign = offset[1] === "-" ? -1 : 1
    const minutes = sign * (Number(offset[2]) * 60 + Number(offset[3]))
    return new Date(ms + minutes * 60_000).toISOString().slice(0, 10)
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms))
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value
  return `${value("year")}-${value("month")}-${value("day")}`
}
const clockJson = (ms: number, timeZone: string) => ({
  currentUtcTime: new Date(ms).toISOString(),
  timeZone,
  localDate: localDateInZone(ms, timeZone),
})

/** Kill Bill 0.24.10 `OverdueWrapper.CLEAR_STATE_NAME`. Not a name from overdue.xml. */
const CLEAR_OVERDUE_STATE = "__KILLBILL__CLEAR__OVERDUE_STATE__"
/** Default `timeSinceEarliestUnpaidInvoiceEqualsOrExceeds` for the single non-clear state. */
const OVERDUE_UNPAID_INVOICE_DAYS = 1

export class KillBillAPI {
  /**
   * The audit columns and requested audit level of the request being handled. Each request runs on
   * its own Object.create(this) view that sets this, so overlapping requests keep their own.
   */
  private requestAudit: RequestAudit | undefined
  readonly state: KillBillState
  private readonly sqlite
  private readonly namespace: string
  private readonly baseNow: () => number
  private readonly username: string
  private readonly password: string
  private readonly tenantKey: string
  private readonly tenantSecret: string
  /**
   * Push notifications are delivered after the request that raised them, in order per account and
   * callback, each `notificationDelayMs` after its event (delays never add up). Every per-request
   * view shares this object, so chains are replaced inside it, never on `this`.
   */
  private readonly outbox: { chains: Map<string, Promise<void>>; queued: Set<string> } = {
    chains: new Map(),
    queued: new Set(),
  }
  constructor(private readonly options: KillBillAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? KILL_BILL_NAMESPACE
    this.baseNow = options.now ?? Date.now
    this.username = options.username ?? "admin"
    this.password = options.password ?? "password"
    this.tenantKey = options.tenantKey ?? "bob"
    this.tenantSecret = options.tenantSecret ?? "lazar"
    this.state = new KillBillState(this.sqlite, this.namespace)
    this.seed()
  }
  private seed() {
    if (!this.state.settings.has("settings"))
      this.state.settings.insert("settings", { declineNext: false, pendingNext: false })
    for (const plan of this.options.plans ?? [
      { name: "standard-monthly", amount: 100, currency: "USD", intervalDays: 30 },
    ])
      this.state.plans.insert(plan.name, plan)
    if (!this.tenantByApiKey(this.tenantKey))
      this.state.tenants.insert(DEFAULT_TENANT_ID, {
        tenantId: DEFAULT_TENANT_ID,
        externalKey: this.tenantKey,
        apiKey: this.tenantKey,
        apiSecret: this.tenantSecret,
        callbacks: [],
      })
  }
  async reset() {
    clearNamespace(this.sqlite, this.namespace)
    this.seed()
  }
  now() {
    return this.state.settings.get("settings")?.clockMs ?? this.baseNow()
  }
  private json(body: unknown, status = 200, headers: HeadersInit = {}) {
    return Response.json(body, {
      status,
      headers: { "x-killbill-request-id": this.state.ids.next("req-", 20), ...headers },
    })
  }
  private empty(status = 204, headers: HeadersInit = {}) {
    return new Response(null, { status, headers })
  }
  /** Kill Bill answers some 404s with no entity, so Tomcat 9.0.98 renders its own error page. */
  private tomcatNotFound() {
    return new Response(TOMCAT_404, {
      status: 404,
      headers: { "content-type": "text/html;charset=utf-8" },
    })
  }
  private problem(status: number, code: string, message: string) {
    return this.json(
      { className: "org.killbill.billing.util.api.KillBillException", code, message },
      status,
    )
  }
  /** Kill Bill 0.24.16's 404 for an id it does not hold ("Object id=… type=ACCOUNT doesn't exist!"). */
  private objectDoesNotExist(type: "ACCOUNT" | "SUBSCRIPTION" | "INVOICE", id: string) {
    return this.javaException(
      404,
      "org.killbill.billing.util.callcontext.InternalCallContextFactory$ObjectDoesNotExist",
      null,
      `Object id=${id} type=${type} doesn't exist!`,
    )
  }
  private accountKeyNotFound(externalKey: string) {
    return this.javaException(
      404,
      "org.killbill.billing.account.api.AccountApiException",
      3003,
      `Account does not exist for key ${externalKey}`,
    )
  }
  // Kill Bill 0.24.16 serializes an uncaught Java exception with its class, code and cause.
  private javaException(
    status: number,
    className: string,
    code: number | null,
    message: string,
    cause?: { className: string; message: string },
  ) {
    return this.json(
      {
        className,
        code,
        message,
        causeClassName: cause?.className ?? null,
        causeMessage: cause?.message ?? null,
        stackTrace: [],
      },
      status,
    )
  }
  private async emit(
    eventType: string,
    objectType: string,
    objectId: string,
    accountId: string | undefined,
    tenantId: string,
  ) {
    this.options.onEvent?.({
      eventType,
      objectType,
      objectId,
      ...(accountId ? { accountId } : {}),
      sequence:
        this.state.audits.list().length +
        this.state.invoices.list().length +
        this.state.payments.list().length +
        1,
      effectiveDate: new Date(this.now()).toISOString(),
    })
    const callbacks = this.state.tenants.get(tenantId)?.callbacks ?? []
    if (callbacks.length === 0) return
    // Kill Bill 0.24.16 posts NotificationJson from its bus after the request has answered (2–3 s
    // later), in order, and GET /test/queues waits for it.
    const body = JSON.stringify({
      eventType,
      accountId: accountId ?? null,
      objectType,
      objectId,
      metaData: null,
    })
    for (const url of callbacks) {
      const id = this.state.ids.next("push-", 24)
      this.state.busEvents.insert(id, { id, eventType, delivery: { url, body, attempts: 0 } })
      this.queueDelivery(id, this.options.notificationDelayMs ?? 2000)
    }
  }
  private queueDelivery(id: string, delayMs: number) {
    if (this.outbox.queued.has(id)) return
    const delivery = (this.state.busEvents.get(id) ?? this.state.notifications.get(id))?.delivery
    if (!delivery) return
    this.outbox.queued.add(id)
    const accountId = (JSON.parse(delivery.body) as { accountId?: string | null }).accountId
    const key = `${delivery.url} ${accountId ?? ""}`
    const due = Date.now() + delayMs
    const chain = (this.outbox.chains.get(key) ?? Promise.resolve())
      .then(() => new Promise((resolve) => setTimeout(resolve, Math.max(0, due - Date.now()))))
      .then(() => this.deliver(id))
      .catch(() => undefined)
      .finally(() => {
        this.outbox.queued.delete(id)
        if (this.outbox.chains.get(key) === chain) this.outbox.chains.delete(key)
      })
    this.outbox.chains.set(key, chain)
  }
  /**
   * One delivery attempt. A 2xx answer ends it; anything else (or no answer) is retried on Kill
   * Bill's schedule, when the clock reaches it (a clock move, or the next request).
   */
  private async deliver(id: string) {
    const queued = this.state.busEvents.get(id) ?? this.state.notifications.get(id)
    const delivery = queued?.delivery
    if (!delivery) return
    let delivered = false
    try {
      const response = await fetch(delivery.url, {
        method: "POST",
        headers: {
          "user-agent": "KillBill/1.0",
          "content-type": "application/json; charset=UTF-8",
        },
        body: delivery.body,
      })
      delivered = response.ok
      await response.body?.cancel()
    } catch {
      delivered = false
    }
    this.state.busEvents.delete(id)
    this.state.notifications.delete(id)
    const delay = NOTIFICATION_RETRY_MS[delivery.attempts]
    if (delivered || delay === undefined) return
    this.state.notifications.insert(id, {
      id,
      kind: PUSH_RETRY,
      effectiveDate: new Date(this.now() + delay).toISOString(),
      delivery: { ...delivery, attempts: delivery.attempts + 1 },
    })
  }
  /**
   * Retries whose time the clock has reached are delivered now, in order, and so is any first
   * delivery not yet on its way (one restored from a snapshot).
   */
  private retryDueNotifications() {
    for (const { value } of this.state.busEvents.list({
      order: "oldest",
      where: (row) => row.delivery !== undefined,
    }))
      this.queueDelivery(value.id, 0)
    const now = this.now()
    for (const { value } of this.state.notifications.list({
      order: "oldest",
      where: (row) => row.kind === PUSH_RETRY && Date.parse(row.effectiveDate) <= now,
    }))
      this.queueDelivery(value.id, 0)
  }
  private audit(request: Request, objectType: string, objectId: string) {
    const createdBy = request.headers.get("x-killbill-createdby") ?? "mockingbird"
    const id = this.state.ids.next("audit-", 24)
    this.state.audits.insert(id, {
      id,
      objectType,
      objectId,
      createdBy,
      ...(request.headers.get("x-killbill-reason")
        ? { reason: request.headers.get("x-killbill-reason") as string }
        : {}),
      ...(request.headers.get("x-killbill-comment")
        ? { comment: request.headers.get("x-killbill-comment") as string }
        : {}),
      createdAt: new Date(this.now()).toISOString(),
    })
  }
  private basicAuthorized(request: Request) {
    const expected = `Basic ${btoa(`${this.username}:${this.password}`)}`
    return request.headers.get("authorization") === expected
  }
  private tenantByApiKey(apiKey: string) {
    return this.state.tenants
      .list({ where: (tenant) => tenant.apiKey === apiKey })
      .map(({ value }) => value)[0]
  }
  private defaultPaymentMethod(accountId: string) {
    return this.state.methods
      .list({ where: (method) => method.accountId === accountId && method.isDefault })
      .map(({ value }) => value)[0]
  }
  // Kill Bill 0.24 creates or reuses __EXTERNAL_PAYMENT__ and does not call a gateway.
  private externalPaymentMethod(accountId: string) {
    const existing = this.state.methods
      .list({
        where: (method) =>
          method.accountId === accountId && method.pluginName === "__EXTERNAL_PAYMENT__",
      })
      .map(({ value }) => value)[0]
    if (existing) return existing
    const paymentMethodId = this.state.ids.next("pm-", 32)
    const method: PaymentMethod = {
      paymentMethodId,
      accountId,
      externalKey: this.state.ids.next("pm-key-", 24),
      pluginName: "__EXTERNAL_PAYMENT__",
      isDefault: false,
    }
    this.state.methods.insert(paymentMethodId, method)
    return method
  }
  private autoPayOff(accountId: string) {
    return this.state.tags.get(`${accountId}\0${AUTO_PAY_OFF_TAG_ID}`) !== undefined
  }
  private invoicePayment(
    payment: Payment,
    targetInvoiceId: string | null = payment.invoiceId ?? null,
  ) {
    return { ...this.paymentJson(payment), targetInvoiceId }
  }
  /** Kill Bill's internal tenant record id: the tenant's creation order. */
  private tenantRecordId(tenantId: string) {
    const index = this.state.tenants
      .list({ order: "oldest" })
      .findIndex(({ value }) => value.tenantId === tenantId)
    return index + 1
  }
  private authenticatedTenant(request: Request) {
    const apiKey = request.headers.get("x-killbill-apikey")
    const apiSecret = request.headers.get("x-killbill-apisecret")
    if (!apiKey || !apiSecret) return undefined
    const tenant = this.tenantByApiKey(apiKey)
    if (!tenant || tenant.apiSecret !== apiSecret) return undefined
    return tenant
  }
  private account(id: string, tenantId: string) {
    const found = this.state.accounts.get(id)
    return found?.tenantId === tenantId ? found : undefined
  }
  private byExternal(key: string, tenantId: string) {
    return this.state.accounts
      .list({ where: (account) => account.externalKey === key && account.tenantId === tenantId })
      .map(({ value }) => value)[0]
  }
  /** Kill Bill 0.24.16 AccountJson fields a client did not set, as null (or their defaults). */
  private accountDefaults(account: Account) {
    return {
      auditLogs: [],
      address1: null,
      address2: null,
      billCycleDayLocal: 0,
      city: null,
      company: null,
      country: null,
      email: null,
      firstNameLength: null,
      isMigrated: null,
      isPaymentDelegatedToParent: false,
      locale: null,
      notes: null,
      parentAccountId: null,
      paymentMethodId: this.defaultPaymentMethod(account.accountId)?.paymentMethodId ?? null,
      phone: null,
      postalCode: null,
      state: null,
    }
  }
  /** The account credit (CBA): the creditAdj of its committed invoices. */
  private accountCredit(accountId: string) {
    return money(
      this.state.invoices
        .list({ where: (i) => i.accountId === accountId && i.status === "COMMITTED" })
        .reduce((sum, row) => sum + row.value.creditAdj, 0),
    )
  }
  private publicAccount(account: Account) {
    const { tenantId: _tenantId, ...rest } = account
    return {
      ...this.accountDefaults(account),
      ...rest,
      // Kill Bill 0.24.16: open balance minus the credit (25 of credit reads -25 / CBA 25).
      accountBalance: money(
        this.state.invoices
          .list({ where: (i) => i.accountId === account.accountId && i.status === "COMMITTED" })
          .reduce((sum, row) => sum + row.value.balance, 0) - this.accountCredit(account.accountId),
      ),
      accountCBA: this.accountCredit(account.accountId),
    }
  }

  private paginate(
    request: Request,
    url: URL,
    resource: "accounts" | "invoices",
    tenantId: string,
  ): Response {
    const integer = (name: string, fallback: number) => {
      const raw = url.searchParams.get(name)
      if (raw === null) return fallback
      if (!/^[+-]?\d+$/.test(raw)) return undefined
      const value = Number(raw)
      return Number.isSafeInteger(value) ? value : undefined
    }
    const offset = integer("offset", 0)
    const limit = integer("limit", 100)
    if (offset === undefined || offset < 0 || limit === undefined)
      return this.problem(
        400,
        "INVALID_PAGINATION",
        "offset must be a nonnegative integer and limit must be an integer",
      )
    const size = Math.abs(limit)
    const accounts = this.state.accounts
      .list({ order: "oldest", where: (row) => row.tenantId === tenantId })
      .map((row) => row.value)
    const accountIds = new Set(accounts.map((row) => row.accountId))
    const rows =
      resource === "accounts"
        ? accounts
        : this.state.invoices
            .list({ where: (row) => accountIds.has(row.accountId) })
            .map((row) => row.value)
            .sort((a, b) => Number(a.invoiceNumber) - Number(b.invoiceNumber))
    if (limit < 0) rows.reverse()
    const total = rows.length
    const headers: Record<string, string> = {
      "x-killbill-pagination-currentoffset": String(offset),
      "x-killbill-pagination-totalnbrecords": String(total),
      "x-killbill-pagination-maxnbrecords": String(total),
    }
    if (offset + size < total) {
      const next = new URL(url)
      const namespace = request.headers.get("x-mockingbird-namespace")
      if (namespace && namespace !== "default")
        next.pathname = `${this.options.adminPrefix ?? "/__admin"}/ns/${encodeURIComponent(namespace)}${url.pathname}`
      next.searchParams.set("offset", String(offset + size))
      next.searchParams.set("limit", String(limit))
      headers["x-killbill-pagination-nextoffset"] = String(offset + size)
      headers["x-killbill-pagination-nextpageuri"] = next.href
    }
    const values = rows.slice(offset, offset + size).map((row) => {
      // Kill Bill 0.24.16 pages invoices without their components (amounts zero, no items).
      if (resource === "invoices") return this.invoiceJson(row as Invoice, false)
      const account = row as Account
      const both = url.searchParams.get("accountWithBalanceAndCBA") === "true"
      const balance = both || url.searchParams.get("accountWithBalance") === "true"
      const { tenantId: _tenantId, ...stored } = account
      const publicRow = balance
        ? this.publicAccount(account)
        : { ...this.accountDefaults(account), ...stored }
      return {
        ...publicRow,
        accountBalance: balance ? publicRow.accountBalance : null,
        accountCBA: both ? publicRow.accountCBA : null,
      }
    })
    return this.json(values, 200, headers)
  }
  private plan(name: string) {
    return this.state.plans.get(name)
  }
  // Kill Bill 0.24 CatalogJson is a list of versions. Plans are nested on products.
  private catalogJson() {
    const plans = this.state.plans.list().map(({ value }) => value)
    const currencies = [...new Set(plans.map((plan) => plan.currency ?? "USD"))]
    return [
      {
        name: "default",
        effectiveDate: new Date(this.now()).toISOString(),
        currencies: currencies.length > 0 ? currencies : ["USD"],
        units: [],
        products: plans.map((plan) => {
          const currency = plan.currency ?? "USD"
          return {
            type: "BASE",
            name: plan.name,
            prettyName: plan.name,
            plans: [
              {
                name: plan.name,
                prettyName: plan.name,
                recurringBillingMode: "IN_ADVANCE",
                billingPeriod: billingPeriod(plan.intervalDays),
                phases: [
                  {
                    type: "EVERGREEN",
                    prices: [{ currency, value: plan.amount }],
                    fixedPrices: [],
                    duration: { unit: "UNLIMITED", number: -1 },
                    usages: [],
                  },
                ],
              },
            ],
            included: [],
            available: [],
          }
        }),
        priceLists: [{ name: "DEFAULT", plans: plans.map((plan) => plan.name) }],
      },
    ]
  }
  private location(request: Request, path: string) {
    return new URL(path, request.url).toString()
  }
  /** A stop day as Kill Bill reports it: the cancel instant on the day it ran, else that day. */
  private stopInstant(subscription: Subscription, day: string | undefined) {
    if (day === undefined) return null
    const at = subscription.cancelledAt
    return at && at.slice(0, 10) === day ? at : `${day}T00:00:00.000Z`
  }
  /**
   * DELETE /1.0/kb/subscriptions/{id} (Kill Bill 0.24.16, parity scenario `cancel-variants`).
   * Entitlement stops at the period end (entitlementPolicy END_OF_TERM), now (IMMEDIATE), else on
   * requestedDate or now. Billing stops at the period end (billingPolicy END_OF_TERM, and the
   * catalog default), now (IMMEDIATE), or on requestedDate with useRequestedDateForBilling. Billing
   * that stops inside a billed period credits its unused share: a REPAIR_ADJ invoice whose
   * CBA_ADJ lands as account credit. A requested instant before the subscription started is
   * EntitlementApiException 1001.
   */
  private async cancelSubscription(subscription: Subscription, url: URL, tenantId: string) {
    const now = this.now()
    const today = isoDate(now)
    const requested = url.searchParams.get("requestedDate") ?? undefined
    const requestedDay = requested?.slice(0, 10)
    if (
      requested?.includes("T") &&
      subscription.createdAt &&
      Date.parse(requested) < Date.parse(subscription.createdAt)
    )
      return this.javaException(
        400,
        "org.killbill.billing.entitlement.api.EntitlementApiException",
        1001,
        `Requested date ${requested} is not allowed to be prior to the previous transition ${new Date(Math.floor(Date.parse(subscription.createdAt) / 1000) * 1000).toISOString()}`,
      )
    const entitlementPolicy = url.searchParams.get("entitlementPolicy")
    const billingPolicy = url.searchParams.get("billingPolicy")
    const useRequested = url.searchParams.get("useRequestedDateForBilling") === "true"
    const periodEnd = subscription.chargedThroughDate ?? subscription.startDate
    const entitlementStop =
      entitlementPolicy === "END_OF_TERM"
        ? periodEnd
        : entitlementPolicy === "IMMEDIATE"
          ? today
          : (requestedDay ?? today)
    const billingStop =
      billingPolicy === "END_OF_TERM"
        ? periodEnd
        : billingPolicy === "IMMEDIATE"
          ? today
          : useRequested && requestedDay
            ? requestedDay
            : periodEnd
    const next: Subscription = {
      ...subscription,
      state:
        entitlementStop <= today && subscription.startDate <= today
          ? "CANCELLED"
          : subscription.state,
      cancelledDate: entitlementStop,
      billingEndDate: billingStop,
      cancelledAt: new Date(now).toISOString(),
      billingStopFirst: billingPolicy === null && useRequested && requested?.includes("T") === true,
    }
    this.state.subscriptions.insert(subscription.subscriptionId, next)
    if (billingStop < periodEnd) await this.repairUnusedPeriod(subscription, billingStop, tenantId)
    return undefined
  }
  /** Credit the unused share of the billed period that billing stops inside (REPAIR_ADJ + CBA_ADJ). */
  private async repairUnusedPeriod(subscription: Subscription, stop: string, tenantId: string) {
    const item = this.state.invoices
      .list({
        where: (row) => row.accountId === subscription.accountId && row.status === "COMMITTED",
      })
      .flatMap(({ value }) => value.items)
      .filter(
        (row) =>
          row.itemType === "RECURRING" &&
          row.subscriptionId === subscription.subscriptionId &&
          row.startDate <= stop &&
          typeof row.endDate === "string" &&
          stop < (row.endDate as string),
      )
      .at(-1)
    if (!item) return
    const end = item.endDate as string
    const share =
      (Date.parse(end) - Date.parse(stop)) / (Date.parse(end) - Date.parse(item.startDate))
    const credit = money(item.amount * share)
    if (credit <= 0) return
    await this.createInvoice(
      subscription.accountId,
      tenantId,
      [
        {
          itemType: "REPAIR_ADJ",
          amount: -credit,
          startDate: stop,
          endDate: end,
          linkedInvoiceItemId: item.invoiceItemId,
          subscriptionId: subscription.subscriptionId,
          description: "Adjustment (subscription repair)",
        },
        {
          itemType: "CBA_ADJ",
          amount: credit,
          startDate: stop,
          endDate: stop,
          description: "Adjustment (account credit)",
        },
      ],
      "Repair",
      { useCredit: false },
    )
  }
  /** Kill Bill 0.24.16 SubscriptionJson, including its entitlement, billing and blocking events. */
  private subscriptionJson(subscription: Subscription) {
    const {
      blockingStates: _blockingStates,
      bcdEffectiveFromDate: _bcd,
      createdAt: _createdAt,
      cancelledAt: _cancelledAt,
      billingStopFirst: _billingStopFirst,
      billingPausedFrom: _billingPausedFrom,
      ...stored
    } = subscription
    const plan = this.plan(subscription.planName)
    const period = billingPeriod(plan?.intervalDays)
    const product = plan?.product ?? subscription.planName
    const phase = `${subscription.planName}-evergreen`
    const startedAt =
      subscription.createdAt && subscription.createdAt.slice(0, 10) === subscription.startDate
        ? subscription.createdAt
        : `${subscription.startDate}T00:00:00.000Z`
    const event = (
      eventId: string,
      eventType: string,
      effectiveDate: string,
      serviceName: string,
      serviceStateName: string,
      blocked: { billing: boolean; entitlement: boolean },
    ) => ({
      auditLogs: [],
      billingPeriod: period,
      catalogEffectiveDate: startedAt,
      effectiveDate,
      eventId,
      eventType,
      isBlockedBilling: blocked.billing,
      isBlockedEntitlement: blocked.entitlement,
      phase,
      plan: subscription.planName,
      priceList: "DEFAULT",
      product,
      serviceName,
      serviceStateName,
    })
    const events = [
      event(
        `${subscription.subscriptionId}-ent`,
        "START_ENTITLEMENT",
        startedAt,
        "entitlement-service",
        "ENT_STARTED",
        { billing: false, entitlement: false },
      ),
      event(
        `${subscription.subscriptionId}-bil`,
        "START_BILLING",
        startedAt,
        "billing-service",
        "START_BILLING",
        { billing: false, entitlement: false },
      ),
    ]
    ;(subscription.blockingStates ?? []).forEach((state, index) => {
      const at = state.createdAt ?? `${state.effectiveDate}T00:00:00.000Z`
      const blocked = {
        billing: state.isBlockBilling,
        entitlement: state.isBlockEntitlement === true,
      }
      const id = `${subscription.subscriptionId}-blk-${index}`
      // Kill Bill reports one event per service a blocking state starts or stops blocking.
      const previous = (subscription.blockingStates ?? [])
        .slice(0, index)
        .filter((entry) => entry.service === state.service)
        .at(-1)
      const was = {
        billing: previous?.isBlockBilling === true,
        entitlement: previous?.isBlockEntitlement === true,
      }
      if (blocked.entitlement !== was.entitlement)
        events.push(
          event(
            id,
            blocked.entitlement ? "PAUSE_ENTITLEMENT" : "RESUME_ENTITLEMENT",
            at,
            state.service,
            state.stateName,
            blocked,
          ),
        )
      if (blocked.billing !== was.billing)
        events.push(
          event(
            id,
            blocked.billing ? "PAUSE_BILLING" : "RESUME_BILLING",
            at,
            state.service,
            state.stateName,
            blocked,
          ),
        )
      if (blocked.billing === was.billing && blocked.entitlement === was.entitlement)
        events.push(event(id, "SERVICE_STATE_CHANGE", at, state.service, state.stateName, blocked))
    })
    const stops: Array<[string, ReturnType<typeof event>]> = []
    if (subscription.cancelledDate !== undefined)
      stops.push([
        `${subscription.cancelledDate}${subscription.billingStopFirst ? "1" : "0"}`,
        event(
          `${subscription.subscriptionId}-stop-ent`,
          "STOP_ENTITLEMENT",
          this.stopInstant(subscription, subscription.cancelledDate) as string,
          "entitlement-service",
          "ENT_CANCELLED",
          { billing: false, entitlement: true },
        ),
      ])
    if (subscription.billingEndDate !== undefined)
      stops.push([
        `${subscription.billingEndDate}${subscription.billingStopFirst ? "0" : "1"}`,
        event(
          `${subscription.subscriptionId}-stop-bil`,
          "STOP_BILLING",
          this.stopInstant(subscription, subscription.billingEndDate) as string,
          "billing-service",
          "STOP_BILLING",
          { billing: false, entitlement: false },
        ),
      ])
    events.push(...stops.sort(([a], [b]) => a.localeCompare(b)).map(([, stop]) => stop))
    const today = isoDate(this.now())
    const entitlementBlocked = this.subscriptionBlocked(subscription, today, "entitlement")
    return {
      auditLogs: [],
      ...stored,
      billCycleDayLocal: this.reportedBillingDay(subscription),
      billingEndDate: this.stopInstant(subscription, subscription.billingEndDate),
      billingPeriod: period,
      billingStartDate: startedAt,
      bundleExternalKey:
        this.state.bundles.get(subscription.bundleId)?.externalKey ?? subscription.bundleId,
      cancelledDate: this.stopInstant(subscription, subscription.cancelledDate),
      chargedThroughDate: subscription.chargedThroughDate ?? null,
      events,
      priceList: "DEFAULT",
      priceOverrides: subscription.priceOverrides ?? null,
      prices: [
        {
          fixedPrice: null,
          phaseName: phase,
          phaseType: subscription.phaseType,
          planName: subscription.planName,
          recurringPrice: plan ? this.recurringAmount(subscription, plan) : null,
          usagePrices: [],
        },
      ],
      productCategory: "BASE",
      productName: product,
      quantity: 1,
      sourceType: "NATIVE",
      startDate: startedAt,
      state:
        subscription.startDate > today
          ? "PENDING"
          : subscription.cancelledDate !== undefined && subscription.cancelledDate <= today
            ? "CANCELLED"
            : subscription.state === "ACTIVE" && entitlementBlocked
              ? "BLOCKED"
              : subscription.state,
    }
  }
  /** Kill Bill 0.24.16 InvoiceItemJson: catalog fields on subscription items, null elsewhere. */
  private invoiceItemJson(stored: InvoiceItem) {
    const { audit, ...item } = stored
    const plan = typeof item.planName === "string" ? this.plan(item.planName) : undefined
    const subscription =
      typeof item.subscriptionId === "string"
        ? this.state.subscriptions.get(item.subscriptionId)
        : undefined
    const recurring = item.itemType === "RECURRING" && plan !== undefined
    const phase = recurring ? `${plan.name}-evergreen` : null
    const product = recurring ? (plan.product ?? plan.name) : null
    return {
      auditLogs: this.auditLogs(audit, "INVOICE_ITEM", item.invoiceItemId),
      bundleId: recurring ? (subscription?.bundleId ?? null) : null,
      catalogEffectiveDate: recurring
        ? (subscription?.createdAt ?? `${item.startDate}T00:00:00.000Z`)
        : null,
      childAccountId: null,
      childItems: null,
      itemDetails: null,
      linkedInvoiceItemId: null,
      phaseName: phase,
      prettyPhaseName: phase,
      prettyPlanName: recurring ? plan.name : null,
      prettyProductName: product,
      prettyUsageName: null,
      productName: product,
      quantity: null,
      rate: recurring ? item.amount : null,
      usageName: null,
      ...item,
      description: recurring ? phase : item.description,
      planName: recurring ? plan.name : (item.planName ?? null),
      subscriptionId: item.subscriptionId ?? null,
      endDate:
        item.endDate ?? (recurring ? addPeriod(item.startDate, plan.intervalDays) : item.startDate),
    }
  }
  /**
   * Kill Bill 0.24.16 InvoiceJson. The account invoice list carries amounts and items only with
   * includeInvoiceComponents=true; single-invoice reads always do.
   */
  private invoiceJson(stored: Invoice, components = true) {
    const { audit, ...invoice } = stored
    return {
      auditLogs: this.auditLogs(audit, "INVOICE", invoice.invoiceId),
      bundleKeys: null,
      credits: null,
      isParentInvoice: false,
      parentAccountId: null,
      parentInvoiceId: null,
      trackingIds: [],
      ...invoice,
      ...(components
        ? { items: invoice.items.map((item) => this.invoiceItemJson(item)) }
        : { amount: 0, balance: 0, creditAdj: 0, refundAdj: 0, items: [] }),
    }
  }
  /** Kill Bill 0.24.16 PaymentJson, as GET /1.0/kb/paymentTransactions returns it. */
  private paymentJson(payment: Payment) {
    return {
      auditLogs: this.auditLogs(payment.audit, "PAYMENT", payment.paymentId, true),
      accountId: payment.accountId,
      authAmount: payment.authAmount,
      capturedAmount: payment.capturedAmount,
      creditedAmount: payment.creditedAmount,
      currency: payment.currency,
      paymentAttempts: null,
      paymentExternalKey: payment.paymentExternalKey,
      paymentId: payment.paymentId,
      paymentMethodId: payment.paymentMethodId ?? null,
      paymentNumber: payment.paymentNumber,
      purchasedAmount: payment.purchasedAmount,
      refundedAmount: payment.refundedAmount,
      transactions: payment.transactions.map((transaction) => ({
        auditLogs: this.auditLogs(
          transaction.audit,
          "TRANSACTION",
          transaction.transactionId,
          true,
        ),
        amount: transaction.amount,
        currency: transaction.currency,
        effectiveDate: transaction.effectiveDate,
        firstPaymentReferenceId: null,
        gatewayErrorCode: transaction.gatewayErrorCode ?? null,
        gatewayErrorMsg: transaction.gatewayErrorMsg ?? null,
        paymentExternalKey: payment.paymentExternalKey,
        paymentId: payment.paymentId,
        processedAmount: transaction.amount,
        processedCurrency: transaction.currency,
        properties: null,
        secondPaymentReferenceId: null,
        status: transaction.status,
        transactionExternalKey: transaction.transactionExternalKey,
        transactionId: transaction.transactionId,
        transactionType: transaction.transactionType,
      })),
    }
  }
  /**
   * POST /1.0/kb/invoices?accountId=…&targetDate=… (Kill Bill 0.24.16): invoice every period of the
   * account's active subscriptions that starts on or before targetDate, without moving the clock.
   * 201 with the invoice Location; nothing to invoice is a 404 with no entity (Tomcat's page).
   */
  private async invoiceThrough(request: Request, url: URL, tenantId: string) {
    const accountId = url.searchParams.get("accountId") ?? ""
    const account = this.account(accountId, tenantId)
    if (!account) return this.objectDoesNotExist("ACCOUNT", accountId)
    const targetDate = url.searchParams.get("targetDate") ?? isoDate(this.now())
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(targetDate) ||
      !Number.isFinite(Date.parse(targetDate)) ||
      isoDate(Date.parse(targetDate)) !== targetDate
    )
      return this.problem(400, "INVALID_DATE", "targetDate must be a valid YYYY-MM-DD date")
    const tooFar = this.targetTooFar(targetDate)
    if (tooFar) return tooFar
    const today = isoDate(this.now())
    const due: Array<{ subscription: Subscription; planName: string; chargedThroughDate: string }> =
      []
    const items: Input[] = []
    for (const { value: subscription } of this.state.subscriptions.list({
      where: (row) => row.accountId === accountId && this.billable(row, targetDate),
    })) {
      const planName = subscription.pendingChangePlan ?? subscription.planName
      const plan = this.plan(planName)
      if (!plan) continue
      const periods = this.duePeriods({ ...subscription, planName }, plan, targetDate)
      if (periods.items.length === 0) continue
      const bound = this.safetyBound(subscription, planName, periods.items, today)
      if (bound) return bound
      items.push(
        ...periods.items.map((item) => ({ ...item, currency: plan.currency ?? account.currency })),
      )
      due.push({ subscription, planName, chargedThroughDate: periods.chargedThroughDate })
    }
    for (const { subscription, planName, chargedThroughDate } of due) {
      const next = { ...subscription, planName, chargedThroughDate, state: "ACTIVE" as const }
      delete next.pendingChangePlan
      delete next.billingPausedFrom
      this.clearEntitlement(subscription.subscriptionId)
      this.state.subscriptions.insert(subscription.subscriptionId, next)
    }
    if (items.length === 0) return this.tomcatNotFound()
    const created = await this.createInvoice(accountId, tenantId, items, "Recurring charge")
    if (!created) return this.objectDoesNotExist("ACCOUNT", accountId)
    const invoice = { ...(this.state.invoices.get(created.invoiceId) ?? created), targetDate }
    this.state.invoices.insert(invoice.invoiceId, invoice)
    const method = this.defaultPaymentMethod(accountId)
    if (method && invoice.balance > 0 && !this.autoPayOff(accountId))
      await this.pay(
        accountId,
        tenantId,
        { amount: invoice.balance, transactionType: "PURCHASE", currency: invoice.currency },
        invoice.invoiceId,
        method.paymentMethodId,
      )
    return this.empty(201, {
      location: this.location(request, `/1.0/kb/invoices/${invoice.invoiceId}`),
    })
  }
  /** Billing, entitlement or change blocked on `date` by the latest state of any service. */
  private subscriptionBlocked(
    subscription: Subscription,
    date: string,
    kind: "billing" | "entitlement",
  ) {
    const services = new Map<string, NonNullable<Subscription["blockingStates"]>[number]>()
    for (const entry of subscription.blockingStates ?? []) {
      const previous = services.get(entry.service)
      if (
        entry.effectiveDate <= date &&
        (!previous || entry.effectiveDate >= previous.effectiveDate)
      )
        services.set(entry.service, entry)
    }
    return [...services.values()].some((entry) =>
      kind === "billing" ? entry.isBlockBilling : entry.isBlockEntitlement === true,
    )
  }
  private async createInvoice(
    accountId: string,
    tenantId: string,
    itemInputs: Input[],
    description = "Invoice",
    options: { status?: Invoice["status"]; useCredit?: boolean; system?: boolean } = {},
  ) {
    const account = this.account(accountId, tenantId)
    if (!account) return undefined
    const invoiceId = this.state.ids.next("inv-", 32)
    const date = isoDate(this.now())
    // A billing run writes as Kill Bill ("SubscriptionBaseTransition"), a client request as itself.
    const audit = this.stamp(options.system ? "SubscriptionBaseTransition" : undefined)
    const items: InvoiceItem[] = itemInputs.map((input) => ({
      ...input,
      ...(audit ? { audit } : {}),
      invoiceItemId: this.state.ids.next("item-", 32),
      invoiceId,
      accountId,
      itemType: typeof input.itemType === "string" ? input.itemType : "EXTERNAL_CHARGE",
      amount: money(input.amount),
      currency: typeof input.currency === "string" ? input.currency : account.currency,
      description: typeof input.description === "string" ? input.description : description,
      startDate: typeof input.startDate === "string" ? input.startDate : date,
    }))
    // Kill Bill 0.24.16: amount counts charges and item adjustments; CBA_ADJ items are the
    // invoice's creditAdj; a CREDIT_ADJ lowers the balance only.
    const sum = (types: string[], include: boolean) =>
      money(
        items
          .filter((i) => types.includes(i.itemType) === include)
          .reduce((s, i) => s + i.amount, 0),
      )
    const amount = sum(["CBA_ADJ", "CREDIT_ADJ"], false)
    let creditAdj = sum(["CBA_ADJ"], true)
    let balance = money(amount + sum(["CREDIT_ADJ"], true) + creditAdj)
    // A new invoice uses the account credit (CBA) first: "Adjustment (use of account credit)".
    const available = options.useCredit === false ? 0 : this.accountCredit(accountId)
    const used = money(Math.min(available, balance))
    if (used > 0) {
      items.push({
        invoiceItemId: this.state.ids.next("item-", 32),
        invoiceId,
        accountId,
        itemType: "CBA_ADJ",
        amount: -used,
        currency: account.currency,
        description: "Adjustment (use of account credit)",
        startDate: date,
        ...(audit ? { audit } : {}),
      })
      creditAdj = money(creditAdj - used)
      balance = money(balance - used)
    }
    const invoice: Invoice = {
      ...(audit ? { audit } : {}),
      invoiceId,
      accountId,
      invoiceNumber: String(this.state.invoices.list().length + 1),
      invoiceDate: date,
      targetDate: date,
      currency: account.currency,
      status: options.status ?? "COMMITTED",
      amount,
      balance,
      creditAdj,
      refundAdj: 0,
      items,
    }
    this.state.invoices.insert(invoiceId, invoice)
    await this.emit("INVOICE_CREATION", "INVOICE", invoiceId, accountId, tenantId)
    return invoice
  }

  /** Net successful purchase minus refund. Kill Bill 0.24.10 voids only when this is zero. */
  private netCollected(invoiceId: string) {
    return money(
      this.state.payments.list({ where: (payment) => payment.invoiceId === invoiceId }).reduce(
        (sum, { value }) =>
          sum +
          value.transactions.reduce((inner, transaction) => {
            if (transaction.status !== "SUCCESS") return inner
            if (transaction.transactionType === "PURCHASE") return inner + transaction.amount
            if (transaction.transactionType === "REFUND") return inner - transaction.amount
            return inner
          }, 0),
        0,
      ),
    )
  }
  /**
   * PUT /1.0/kb/invoices/{invoiceId}/voidInvoice (Kill Bill 0.24.10).
   * A paid invoice and a second void are both 400 via InvoiceApiExceptionMapper.fallback.
   */
  private async voidInvoice(invoice: Invoice, tenantId: string) {
    if (this.netCollected(invoice.invoiceId) !== 0)
      return this.problem(
        400,
        "CAN_NOT_VOID_INVOICE_THAT_IS_PAID",
        "Invoice can not be voided. Invoice is paid or partially paid.",
      )
    if (invoice.status === "VOID")
      return this.problem(
        400,
        "INVOICE_INVALID_STATUS",
        "The invoice status VOID is invalid. Current status is VOID",
      )
    this.state.invoices.insert(invoice.invoiceId, { ...invoice, status: "VOID", balance: 0 })
    await this.emit("INVOICE_VOID", "INVOICE", invoice.invoiceId, invoice.accountId, tenantId)
    return this.empty()
  }
  private transaction(
    payment: Payment,
    type: Transaction["transactionType"],
    amount: number,
    status: Transaction["status"],
    externalKey?: string,
  ) {
    const transactionId = this.state.ids.next("txn-", 32)
    // Kill Bill 0.24.16 keys an unkeyed transaction (and payment) by its own id.
    const audit = this.stamp()
    const transaction: Transaction = {
      ...(audit ? { audit } : {}),
      transactionId,
      paymentId: payment.paymentId,
      transactionExternalKey: externalKey ?? transactionId,
      transactionType: type,
      effectiveDate: new Date(this.now()).toISOString(),
      status,
      amount: money(amount),
      currency: payment.currency,
      ...(status === "PAYMENT_FAILURE"
        ? { gatewayErrorCode: "DECLINED", gatewayErrorMsg: "Mockingbird declined payment" }
        : {}),
    }
    return transaction
  }
  private async pay(
    accountId: string,
    tenantId: string,
    input: Input,
    invoiceId?: string,
    paymentMethodId?: string,
    external = false,
  ) {
    const account = this.account(accountId, tenantId)
    if (!account) return undefined
    const paymentExternalKey =
      typeof input.paymentExternalKey === "string" ? input.paymentExternalKey : undefined
    const transactionExternalKey =
      typeof input.transactionExternalKey === "string" ? input.transactionExternalKey : undefined
    const prior = this.state.payments
      .list({
        where: (payment) =>
          payment.accountId === accountId &&
          ((paymentExternalKey !== undefined &&
            payment.paymentExternalKey === paymentExternalKey) ||
            (transactionExternalKey !== undefined &&
              payment.transactions.some(
                (transaction) => transaction.transactionExternalKey === transactionExternalKey,
              ))),
      })
      .map(({ value }) => value)[0]
    if (prior) return prior
    const settings = this.state.settings.get("settings") ?? {
      declineNext: false,
      pendingNext: false,
    }
    const amount = money(
      input.amount ?? (invoiceId ? this.state.invoices.get(invoiceId)?.balance : 0),
    )
    const paymentId = this.state.ids.next("pay-", 32)
    const status: Transaction["status"] = external
      ? "SUCCESS"
      : settings.declineNext
        ? "PAYMENT_FAILURE"
        : settings.pendingNext
          ? "PENDING"
          : "SUCCESS"
    if (!external)
      this.state.settings.insert("settings", {
        ...settings,
        declineNext: false,
        pendingNext: false,
      })
    const type = (
      typeof input.transactionType === "string" ? input.transactionType : "PURCHASE"
    ) as Transaction["transactionType"]
    const paymentAudit = this.stamp()
    const payment: Payment = {
      ...(paymentAudit ? { audit: paymentAudit } : {}),
      paymentId,
      accountId,
      ...(invoiceId ? { invoiceId } : {}),
      paymentNumber: String(this.state.payments.list().length + 1),
      paymentExternalKey: paymentExternalKey ?? paymentId,
      authAmount: type === "AUTHORIZE" && status === "SUCCESS" ? amount : 0,
      capturedAmount: 0,
      purchasedAmount: type === "PURCHASE" && status === "SUCCESS" ? amount : 0,
      refundedAmount: 0,
      creditedAmount: type === "CREDIT" && status === "SUCCESS" ? amount : 0,
      currency: typeof input.currency === "string" ? input.currency : account.currency,
      ...(paymentMethodId ? { paymentMethodId } : {}),
      transactions: [],
      paymentAttempts: [],
    }
    const transaction = this.transaction(payment, type, amount, status, transactionExternalKey)
    payment.transactions = [transaction]
    payment.paymentAttempts = [
      {
        paymentAttemptId: this.state.ids.next("attempt-", 24),
        accountId,
        paymentId,
        paymentExternalKey: payment.paymentExternalKey,
        transactionId: transaction.transactionId,
        transactionExternalKey: transaction.transactionExternalKey,
        transactionType: type,
        effectiveDate: transaction.effectiveDate,
        stateName: status,
      },
    ]
    this.state.payments.insert(paymentId, payment)
    if (invoiceId && status === "SUCCESS") {
      const invoice = this.state.invoices.get(invoiceId)
      if (invoice)
        this.state.invoices.insert(invoiceId, {
          ...invoice,
          balance: money(Math.max(0, invoice.balance - amount)),
        })
    }
    await this.emit(
      status === "SUCCESS"
        ? "PAYMENT_SUCCESS"
        : status === "PENDING"
          ? "PAYMENT_PENDING"
          : "PAYMENT_FAILED",
      "PAYMENT",
      paymentId,
      accountId,
      tenantId,
    )
    if (invoiceId && type === "PURCHASE" && status !== "PENDING")
      await this.emit(
        status === "SUCCESS" ? "INVOICE_PAYMENT_SUCCESS" : "INVOICE_PAYMENT_FAILED",
        "INVOICE",
        invoiceId,
        this.state.invoices.get(invoiceId)?.accountId ?? accountId,
        tenantId,
      )
    return payment
  }
  async notifyInvoicePaymentSuccess(payment: Payment) {
    const account = this.state.accounts.get(payment.accountId)
    if (!account) return
    await this.emit(
      "PAYMENT_SUCCESS",
      "PAYMENT",
      payment.paymentId,
      payment.accountId,
      account.tenantId,
    )
    if (payment.invoiceId && payment.transactions.at(-1)?.transactionType === "PURCHASE")
      await this.emit(
        "INVOICE_PAYMENT_SUCCESS",
        "INVOICE",
        payment.invoiceId,
        this.state.invoices.get(payment.invoiceId)?.accountId ?? payment.accountId,
        account.tenantId,
      )
  }
  private overdueState(accountId: string) {
    const earliest = this.state.invoices
      .list({
        where: (invoice) =>
          invoice.accountId === accountId && invoice.status !== "VOID" && invoice.balance > 0,
      })
      .map(({ value }) => value.invoiceDate)
      .sort()[0]
    const ageDays =
      earliest === undefined
        ? undefined
        : Math.round(
            (Date.parse(`${isoDate(this.now())}T00:00:00.000Z`) -
              Date.parse(`${earliest}T00:00:00.000Z`)) /
              86_400_000,
          )
    const matched = ageDays !== undefined && ageDays >= OVERDUE_UNPAID_INVOICE_DAYS
    return {
      name: matched ? "OD1" : CLEAR_OVERDUE_STATE,
      externalMessage: "",
      isDisableEntitlementAndChangesBlocked: false,
      isBlockChanges: false,
      isClearState: !matched,
      reevaluationIntervalDays: null,
    }
  }
  private successfulTransaction(externalKey: string) {
    for (const { value } of this.state.payments.list()) {
      const transaction = value.transactions.find(
        (row) => row.transactionExternalKey === externalKey && row.status === "SUCCESS",
      )
      if (transaction) return transaction
    }
    return undefined
  }
  private creditedAgainst(paymentId: string) {
    return money(
      this.state.payments
        .list({ where: (payment) => payment.linkedPaymentId === paymentId })
        .reduce((sum, row) => sum + row.value.creditedAmount, 0),
    )
  }
  private refundableRemaining(payment: Payment) {
    return money(
      payment.purchasedAmount - payment.refundedAmount - this.creditedAgainst(payment.paymentId),
    )
  }
  /**
   * An invoice-payment refund on the invoice it paid (Kill Bill 0.24.16, probed): refundAdj drops by
   * the refund either way. With isAdjusted, ITEM_ADJ items ("Invoice item adjustment", linked to the
   * requested items, else the first item) lower the amount and the balance stays; without it the
   * refund reopens the balance.
   */
  private reopenInvoice(
    payment: Payment,
    amount: number,
    adjust: boolean,
    adjustments: unknown = [],
  ) {
    if (!payment.invoiceId) return
    const invoice = this.state.invoices.get(payment.invoiceId)
    if (!invoice) return
    const requested = Array.isArray(adjustments)
      ? adjustments.map(object).filter((entry) => typeof entry.invoiceItemId === "string")
      : []
    // An adjustment without an amount adjusts its whole item, never more than the refund left.
    let left = amount
    const targets = !adjust
      ? []
      : requested.length > 0
        ? requested.map((entry) => {
            const item = invoice.items.find((row) => row.invoiceItemId === entry.invoiceItemId)
            const wanted = money(entry.amount ?? item?.amount ?? left)
            const take = money(Math.min(wanted, left))
            left = money(left - take)
            return { itemId: entry.invoiceItemId as string, amount: take }
          })
        : [{ itemId: invoice.items[0]?.invoiceItemId, amount }]
    const audit = this.stamp()
    const items: InvoiceItem[] = targets.map((target) => ({
      invoiceItemId: this.state.ids.next("item-", 32),
      invoiceId: invoice.invoiceId,
      accountId: invoice.accountId,
      itemType: "ITEM_ADJ",
      amount: -target.amount,
      currency: invoice.currency,
      description: "Invoice item adjustment",
      startDate: isoDate(this.now()),
      ...(target.itemId ? { linkedInvoiceItemId: target.itemId } : {}),
      ...(audit ? { audit } : {}),
    }))
    const adjusted = money(targets.reduce((sum, target) => sum + target.amount, 0))
    this.state.invoices.insert(invoice.invoiceId, {
      ...invoice,
      amount: money(invoice.amount - adjusted),
      balance: money(invoice.balance + amount - adjusted),
      refundAdj: money(invoice.refundAdj - amount),
      items: [...invoice.items, ...items],
    })
  }
  /** Kill Bill 0.24.16 `InvoicePaymentResource.createRefundWithAdjustments`. */
  private async refundInvoicePayment(
    request: Request,
    url: URL,
    payment: Payment,
    body: Input,
    tenantId: string,
  ) {
    const externalKey =
      typeof body.transactionExternalKey === "string" ? body.transactionExternalKey : undefined
    if (externalKey && this.successfulTransaction(externalKey))
      return this.problem(
        400,
        "PAYMENT_ACTIVE_TRANSACTION_KEY_EXISTS",
        `Successful transaction with external key ${externalKey} already exists`,
      )
    const amount =
      body.amount === undefined || body.amount === null
        ? this.refundableRemaining(payment)
        : money(body.amount)
    if (!Number.isFinite(amount) || amount <= 0 || amount > this.refundableRemaining(payment))
      return this.problem(400, "REFUND_AMOUNT_TOO_HIGH", "Refund amount exceeds purchased amount")
    const adjust = body.isAdjusted === true
    // externalPayment records a credit on a new payment. It does not add a REFUND to this one.
    if (url.searchParams.get("externalPayment") === "true") {
      const requestedMethod = url.searchParams.get("paymentMethodId") ?? undefined
      if (requestedMethod) {
        const method = this.state.methods.get(requestedMethod)
        if (!method)
          return this.problem(404, "PAYMENT_NO_SUCH_PAYMENT_METHOD", "Payment method not found")
        if (method.accountId !== payment.accountId)
          return this.problem(
            400,
            "PAYMENT_METHOD_DIFFERENT_ACCOUNT_ID",
            "Payment method belongs to another account",
          )
      }
      const paymentMethodId = requestedMethod ?? payment.paymentMethodId
      const paymentId = this.state.ids.next("pay-", 32)
      const creditAudit = this.stamp()
      const credit: Payment = {
        ...(creditAudit ? { audit: creditAudit } : {}),
        paymentId,
        accountId: payment.accountId,
        paymentNumber: String(this.state.payments.list().length + 1),
        // Kill Bill 0.24.16 gives the credit payment its own generated key, not its id.
        paymentExternalKey:
          typeof body.paymentExternalKey === "string"
            ? body.paymentExternalKey
            : this.state.ids.next("payment-key-", 24),
        authAmount: 0,
        capturedAmount: 0,
        purchasedAmount: 0,
        refundedAmount: 0,
        creditedAmount: amount,
        currency: typeof body.currency === "string" ? body.currency : payment.currency,
        ...(paymentMethodId ? { paymentMethodId } : {}),
        linkedPaymentId: payment.paymentId,
        transactions: [],
        paymentAttempts: [],
      }
      credit.transactions = [this.transaction(credit, "CREDIT", amount, "SUCCESS", externalKey)]
      this.state.payments.insert(paymentId, credit)
      this.reopenInvoice(payment, amount, adjust, body.adjustments)
      await this.emit("PAYMENT_SUCCESS", "PAYMENT", paymentId, payment.accountId, tenantId)
      return this.empty(201, {
        location: this.location(request, `/1.0/kb/invoicePayments/${paymentId}`),
      })
    }
    const transaction = this.transaction(payment, "REFUND", amount, "SUCCESS", externalKey)
    this.state.payments.insert(payment.paymentId, {
      ...payment,
      refundedAmount: money(payment.refundedAmount + amount),
      transactions: [...payment.transactions, transaction],
    })
    this.reopenInvoice(payment, amount, adjust, body.adjustments)
    await this.emit("PAYMENT_REFUND", "PAYMENT", payment.paymentId, payment.accountId, tenantId)
    return this.empty(201, {
      location: this.location(request, `/1.0/kb/invoicePayments/${payment.paymentId}`),
    })
  }
  /**
   * Recurring price for this mock's single evergreen phase.
   * Kill Bill 0.24 applies a priceOverrides entry only to the phase it names
   * (`{planName}-evergreen`, or phaseType EVERGREEN when the name is omitted).
   */
  private recurringAmount(subscription: Subscription, plan: CatalogPlan) {
    const evergreen = `${plan.name}-evergreen`
    for (const raw of subscription.priceOverrides ?? []) {
      if (!raw || typeof raw !== "object") continue
      const phaseName = typeof raw.phaseName === "string" ? raw.phaseName : undefined
      const phaseType = typeof raw.phaseType === "string" ? raw.phaseType.toUpperCase() : undefined
      const matches =
        phaseName === evergreen || (phaseName === undefined && phaseType === "EVERGREEN")
      if (!matches || raw.recurringPrice === undefined || raw.recurringPrice === null) continue
      const price = money(raw.recurringPrice)
      if (Number.isFinite(price)) return price
    }
    return plan.amount
  }
  /**
   * The BCD Kill Bill 0.24.16 reports: the start day until the clock reaches the first new billing
   * day on or after the BCD's effective date (BCD 5 from 02-01 reads 5 from 02-05).
   */
  private reportedBillingDay(subscription: Subscription) {
    const startDay = Number(subscription.startDate.slice(8, 10))
    const day = subscription.billCycleDayLocal
    const effective = subscription.bcdEffectiveFromDate
    if (day === undefined || effective === undefined) return startDay
    const [year, month] = effective.split("-").map(Number) as [number, number]
    const onDay = (monthIndex: number) => {
      const last = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
      return isoDate(Date.UTC(year, monthIndex, Math.min(day, last)))
    }
    const first = onDay(month - 1) >= effective ? onDay(month - 1) : onDay(month)
    return isoDate(this.now()) >= first ? day : startDay
  }
  /** The day of the month a period starting on `start` bills on: the BCD once it is effective. */
  private billingDay(subscription: Subscription, start: string) {
    const changed =
      subscription.billCycleDayLocal !== undefined &&
      subscription.bcdEffectiveFromDate !== undefined &&
      start >= subscription.bcdEffectiveFromDate
    return changed
      ? (subscription.billCycleDayLocal as number)
      : Number(subscription.startDate.slice(8, 10))
  }
  /**
   * One billing period from `start`, as Kill Bill 0.24.16 cuts it (probed with the test clock).
   * Monthly plans bill calendar months on the billing day, clamped to the month's last day. A start
   * off that day bills a stub up to the next billing day, prorated over the month from `start`
   * (02-01..02-05 of a $10 plan is $1.43), on the later of the BCD's effective date and the last
   * billing day on or before `start` (BCD 31 from 01-01 bills 02-01..02-28 on 01-31). Other plans
   * bill whole periods: years for annual plans, days otherwise.
   */
  private billingPeriod(subscription: Subscription, plan: CatalogPlan, start: string) {
    const days = plan.intervalDays ?? 30
    if (days !== 30) return { end: addPeriod(start, days), fraction: 1, billOn: start }
    const day = this.billingDay(subscription, start)
    const [year, month] = start.split("-").map(Number) as [number, number]
    const onDay = (monthIndex: number) => {
      const last = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
      return isoDate(Date.UTC(year, monthIndex, Math.min(day, last)))
    }
    const thisMonth = onDay(month - 1)
    if (thisMonth === start) return { end: onDay(month), fraction: 1, billOn: start }
    const end = thisMonth > start ? thisMonth : onDay(month)
    const previous = thisMonth < start ? thisMonth : onDay(month - 2)
    const effective = subscription.bcdEffectiveFromDate ?? start
    // Billed on a new billing day, the stub is prorated over that new period (BCD 5 from 01-01:
    // 02-01..02-05 is 4/31 of 01-05..02-05); otherwise over the month from its start (4/28).
    const realigned = previous > effective
    const whole = realigned
      ? Date.parse(end) - Date.parse(previous)
      : Date.parse(addPeriod(start, 30)) - Date.parse(start)
    return {
      end,
      fraction: (Date.parse(end) - Date.parse(start)) / whole,
      billOn: realigned ? previous : effective < start ? effective : start,
    }
  }
  /** The recurring items due through `through` (inclusive) and the charged-through date after them. */
  private duePeriods(subscription: Subscription, plan: CatalogPlan, through: string) {
    const items: Input[] = []
    let start = subscription.chargedThroughDate ?? subscription.startDate
    // A subscription whose billing is blocked on `through` bills nothing. After a pause, Kill Bill
    // 0.24.16 bills from the resume day (parity scenario `billing-pause-resume`).
    if (this.subscriptionBlocked(subscription, through, "billing"))
      return { items, chargedThroughDate: start }
    if (subscription.billingPausedFrom !== undefined)
      start = this.billingTransition(subscription, through, false) ?? start
    while (true) {
      // A cancelled subscription bills nothing from the day its billing stops.
      if (subscription.billingEndDate !== undefined && start >= subscription.billingEndDate) break
      const { end, fraction, billOn } = this.billingPeriod(subscription, plan, start)
      if (billOn > through) break
      items.push({
        itemType: "RECURRING",
        amount: money(this.recurringAmount(subscription, plan) * fraction),
        currency: plan.currency ?? "USD",
        description: plan.name,
        startDate: start,
        endDate: end,
        subscriptionId: subscription.subscriptionId,
        planName: plan.name,
      })
      start = end
    }
    return { items, chargedThroughDate: start }
  }
  /** A subscription bills from its start: active ones, and pending ones whose start has come. */
  private billable(subscription: Subscription, date: string) {
    return (
      subscription.state === "ACTIVE" ||
      (subscription.state === "PENDING" && subscription.startDate.slice(0, 10) <= date)
    )
  }
  /**
   * Kill Bill 0.24.16 refuses to create more than 15 items for one subscription in a day, previews
   * included (InvoiceApiException 4, parity scenario `invoice-target-dates`).
   */
  private safetyBound(subscription: Subscription, planName: string, items: Input[], today: string) {
    const createdToday = this.state.invoices
      .list({
        where: (row) => row.accountId === subscription.accountId && row.invoiceDate === today,
      })
      .flatMap(({ value }) => value.items)
      .filter((row) => row.subscriptionId === subscription.subscriptionId).length
    const item = items[Math.max(SAFETY_BOUND - createdToday, 0)]
    if (!item) return undefined
    return this.javaException(
      400,
      "org.killbill.billing.invoice.api.InvoiceApiException",
      4,
      `SAFETY BOUND TRIGGERED subscriptionId='${subscription.subscriptionId}', resultingItem=RECURRING{planName='${planName}', startDate=${item.startDate}, endDate=${item.endDate}, amount=${item.amount}}`,
    )
  }
  /**
   * Kill Bill 0.24.16 refuses a target date 37 months or more after today (InvoiceApiException
   * 4005; 2029-12-05 passed and 2029-12-06 failed on 2026-11-06, parity scenario
   * `invoice-target-dates`).
   */
  private targetTooFar(targetDate: string) {
    const today = new Date(`${isoDate(this.now())}T00:00:00.000Z`)
    const limit = isoDate(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 37, today.getUTCDate()),
    )
    if (targetDate < limit) return undefined
    return this.javaException(
      400,
      "org.killbill.billing.invoice.api.InvoiceApiException",
      4005,
      `The target date was too far in the future. Target Date: ${targetDate}`,
    )
  }
  /** The latest day on or before `date` that billing became blocked (`true`) or unblocked. */
  private billingTransition(subscription: Subscription, date: string, blocked: boolean) {
    const days = [...new Set((subscription.blockingStates ?? []).map((s) => s.effectiveDate))]
      .filter((day) => day <= date)
      .sort()
    let previous = false
    let found: string | undefined
    for (const day of days) {
      const now = this.subscriptionBlocked(subscription, day, "billing")
      if (now !== previous && now === blocked) found = day
      previous = now
    }
    return found
  }
  /**
   * A billing pause that has taken effect credits the rest of the billed period it falls in, as
   * Kill Bill 0.24.16 does (REPAIR_ADJ + CBA_ADJ; parity scenario `billing-pause-resume`).
   */
  private async startBillingPause(subscription: Subscription, today: string, tenantId: string) {
    if (subscription.billingPausedFrom !== undefined) return subscription
    if (!this.subscriptionBlocked(subscription, today, "billing")) return subscription
    const from = this.billingTransition(subscription, today, true)
    if (from === undefined) return subscription
    const next = { ...subscription, billingPausedFrom: from }
    this.state.subscriptions.insert(subscription.subscriptionId, next)
    if (subscription.chargedThroughDate !== undefined && from < subscription.chargedThroughDate)
      await this.repairUnusedPeriod(subscription, from, tenantId)
    return next
  }
  private async billDue(tenantId: string, accountId?: string) {
    const today = isoDate(this.now())
    for (const { value: stored } of this.state.subscriptions.list({
      where: (s) =>
        (accountId === undefined || s.accountId === accountId) &&
        this.billable(s, today) &&
        this.account(s.accountId, tenantId) !== undefined,
    })) {
      const current = await this.startBillingPause(stored, today, tenantId)
      // An end-of-term plan change takes effect on the renewal it was scheduled for.
      const planName = current.pendingChangePlan ?? current.planName
      const plan = this.plan(planName)
      if (!plan) continue
      const subscription = { ...current, planName }
      const { items, chargedThroughDate } = this.duePeriods(subscription, plan, today)
      if (items.length === 0) continue
      const invoice = await this.createInvoice(
        subscription.accountId,
        tenantId,
        items,
        "Recurring charge",
        { system: true },
      )
      const next = { ...subscription, chargedThroughDate, state: "ACTIVE" as const }
      delete next.pendingChangePlan
      delete next.billingPausedFrom
      this.clearEntitlement(subscription.subscriptionId)
      this.state.subscriptions.insert(subscription.subscriptionId, next)
      const method = this.state.methods
        .list({ where: (m) => m.accountId === subscription.accountId && m.isDefault })
        .map(({ value }) => value)[0]
      // Kill Bill 0.24.10 skips automatic payment on an AUTO_PAY_OFF account, and pays only what is
      // still owed: a push-notification consumer may have paid the invoice during INVOICE_CREATION.
      const owed = invoice ? (this.state.invoices.get(invoice.invoiceId)?.balance ?? 0) : 0
      if (invoice && method && owed > 0 && !this.autoPayOff(subscription.accountId))
        await this.pay(
          subscription.accountId,
          tenantId,
          { amount: owed, transactionType: "PURCHASE", currency: invoice.currency },
          invoice.invoiceId,
          method.paymentMethodId,
        )
    }
  }
  private entitlementNotificationId(subscriptionId: string) {
    return `entitlement:${subscriptionId}`
  }
  private scheduleEntitlement(subscription: Subscription) {
    const day = subscription.chargedThroughDate ?? subscription.startDate
    const id = this.entitlementNotificationId(subscription.subscriptionId)
    this.state.notifications.insert(id, {
      id,
      effectiveDate: `${day}T00:00:00.000Z`,
      kind: "ENTITLEMENT_CHANGE",
    })
  }
  private clearEntitlement(subscriptionId: string) {
    this.state.notifications.delete(this.entitlementNotificationId(subscriptionId))
  }
  // Kill Bill 0.24.10 TestResource counts a notification only when its effective
  // date is not after the clock. Bus events have no date filter.
  private queuesIdle() {
    const now = this.now()
    const due = this.state.notifications.list({
      where: (notification) => {
        const effective = Date.parse(notification.effectiveDate)
        return Number.isFinite(effective) && effective <= now
      },
    })
    return due.length === 0 && this.state.busEvents.count() === 0
  }
  private async waitForQueues(timeoutSec: number) {
    let triesLeft = timeoutSec
    let idle = false
    while (!idle && triesLeft > 0) {
      idle = this.queuesIdle()
      if (!idle) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        triesLeft -= 1
      }
    }
    return idle
  }
  private async body(request: Request) {
    const text = await request.text()
    if (!text) return {}
    try {
      return JSON.parse(text) as Input
    } catch {
      return { raw: text }
    }
  }
  private async tenants(request: Request, url: URL) {
    if (request.method === "GET") {
      const apiKey = url.searchParams.get("apiKey")
      const tenant = apiKey ? this.tenantByApiKey(apiKey) : undefined
      return tenant
        ? this.json({
            tenantId: tenant.tenantId,
            externalKey: tenant.externalKey,
            apiKey: tenant.apiKey,
          })
        : this.problem(
            404,
            "TENANT_DOES_NOT_EXIST",
            `Tenant does not exist for api key ${apiKey ?? ""}`,
          )
    }
    if (request.method !== "POST")
      return this.problem(
        404,
        "NOT_FOUND",
        `No Kill Bill route for ${request.method} ${url.pathname}`,
      )
    const body = await this.body(request)
    const apiKey = typeof body.apiKey === "string" ? body.apiKey : ""
    const apiSecret = typeof body.apiSecret === "string" ? body.apiSecret : ""
    if (!apiKey || !apiSecret)
      return this.problem(400, "INVALID_TENANT", "apiKey and apiSecret are required")
    if (this.tenantByApiKey(apiKey)) {
      const key =
        typeof body.externalKey === "string" && body.externalKey ? body.externalKey : apiKey
      return this.problem(409, "TENANT_ALREADY_EXISTS", `Tenant already exists for key ${key}`)
    }
    const tenantId = this.state.ids.next("tenant-", 32)
    const externalKey = typeof body.externalKey === "string" ? body.externalKey : ""
    this.state.tenants.insert(tenantId, {
      tenantId,
      externalKey,
      apiKey,
      apiSecret,
      callbacks: [],
    })
    this.audit(request, "TENANT", tenantId)
    return this.empty(201, { location: this.location(request, `/1.0/kb/tenants/${tenantId}`) })
  }
  private notificationCallback(request: Request, url: URL, tenant: Tenant) {
    if (request.method === "GET")
      return this.json({ key: NOTIFICATION_KEY, values: tenant.callbacks })
    if (request.method === "DELETE") {
      this.state.tenants.insert(tenant.tenantId, { ...tenant, callbacks: [] })
      return this.empty()
    }
    if (request.method === "POST") {
      const callback = url.searchParams.get("cb")
      if (!callback) return this.problem(400, "INVALID_CALLBACK", "cb is required")
      // PUSH_NOTIFICATION_CB is a single-value key: POST replaces the previous URL.
      this.state.tenants.insert(tenant.tenantId, { ...tenant, callbacks: [callback] })
      return this.empty(201, {
        location: this.location(request, "/1.0/kb/tenants/registerNotificationCallback"),
      })
    }
    return this.problem(
      404,
      "NOT_FOUND",
      `No Kill Bill route for ${request.method} ${url.pathname}`,
    )
  }

  async fetch(request: Request): Promise<Response> {
    const level = (new URL(request.url).searchParams.get("audit") ?? "NONE").toUpperCase()
    // Kill Bill 0.24.16 stamps every row a request writes with its X-Killbill-CreatedBy, -Comment
    // and -Reason, and its X-Request-Id as userToken (one is generated, from the instance's ids,
    // when absent and the request writes).
    const audit: RequestAudit = {
      changeDate: new Date(Math.floor(this.now() / 1000) * 1000).toISOString(),
      changedBy: request.headers.get("x-killbill-createdby") ?? "",
      comments: request.headers.get("x-killbill-comment") ?? null,
      reasonCode: request.headers.get("x-killbill-reason") ?? null,
      userToken: request.headers.get("x-request-id") ?? "",
      level: level === "FULL" || level === "MINIMAL" ? level : "NONE",
    }
    this.retryDueNotifications()
    const scoped: KillBillAPI = Object.create(this)
    scoped.requestAudit = audit
    return scoped.handle(request)
  }
  /** The audit stamp for rows the current request writes; billing runs write as Kill Bill. */
  private stamp(changedBy?: string): AuditStamp | undefined {
    const current = this.requestAudit
    if (!current) return undefined
    if (!current.userToken) current.userToken = this.state.ids.next("request-", 24)
    const { level: _level, ...stamp } = current
    return changedBy ? { ...stamp, changedBy } : stamp
  }
  /** auditLogs for a read: [] unless audit=MINIMAL (the INSERT) or FULL (also the UPDATE). */
  private auditLogs(
    stamp: AuditStamp | undefined,
    objectType: string,
    objectId: string,
    updated = false,
  ) {
    const level = this.requestAudit?.level ?? "NONE"
    if (level === "NONE" || !stamp) return []
    const row = (changeType: string) => ({
      changeType,
      ...stamp,
      objectType,
      objectId,
      history: null,
    })
    return level === "FULL" && updated ? [row("INSERT"), row("UPDATE")] : [row("INSERT")]
  }
  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/1.0/healthcheck" || url.pathname === "/healthcheck")
      return this.json({ status: "UP" })
    if (!this.basicAuthorized(request)) return this.problem(401, "UNAUTHORIZED", "Unauthorized")
    // Permissions are global to the authenticated user, independent of tenant access.
    if (url.pathname === "/1.0/kb/security/permissions" && request.method === "GET")
      return this.json(["*:*"])
    // Kill Bill 0.24 TenantFilter skips api key headers on exactly /1.0/kb/tenants.
    if (url.pathname === "/1.0/kb/tenants") {
      if (request.method !== "GET" && !request.headers.get("x-killbill-createdby"))
        return this.problem(400, "MISSING_CREATED_BY", "X-Killbill-CreatedBy is required")
      return this.tenants(request, url)
    }
    const tenant = this.authenticatedTenant(request)
    if (!tenant) return this.problem(401, "UNAUTHORIZED", "Unauthorized")
    if (request.method !== "GET" && !request.headers.get("x-killbill-createdby"))
      return this.problem(400, "MISSING_CREATED_BY", "X-Killbill-CreatedBy is required")
    const tenantId = tenant.tenantId
    const path = url.pathname.replace(/^\/1\.0\/kb\/?/, "")
    const parts = path.split("/").filter(Boolean)
    const body = await this.body(request)
    if (
      (parts[0] === "accounts" || parts[0] === "invoices") &&
      parts[1] === "pagination" &&
      parts.length === 2 &&
      request.method === "GET"
    )
      return this.paginate(request, url, parts[0], tenantId)
    if (parts[0] === "tenants" && parts[1] === "registerNotificationCallback")
      return this.notificationCallback(request, url, tenant)
    if (parts[0] === "test" && parts[1] === "clock") {
      const zone = clockZone(url.searchParams.get("timeZone"))
      if (!zone) return this.problem(400, "INVALID_TIMEZONE", "Invalid timezone supplied")
      if (request.method === "GET") return this.json(clockJson(this.now(), zone))
      const requested =
        url.searchParams.get("requestedDate") ??
        (typeof body.requestedDate === "string" ? body.requestedDate : undefined)
      const settings = this.state.settings.get("settings") ?? {
        declineNext: false,
        pendingNext: false,
      }
      // Kill Bill 0.24.16: a POST with no requestedDate resets the test clock to the system time.
      if (requested === undefined && request.method === "POST") {
        const { clockMs: _clockMs, ...rest } = settings
        this.state.settings.insert("settings", rest)
        await this.billDue(tenantId)
        return this.json(clockJson(this.now(), zone))
      }
      const parsed = requested ? Date.parse(requested) : Number.NaN
      if (!Number.isFinite(parsed))
        return this.problem(400, "INVALID_DATE", "requestedDate is required")
      this.state.settings.insert("settings", { ...settings, clockMs: parsed })
      await this.billDue(tenantId)
      this.retryDueNotifications()
      return this.json(clockJson(parsed, zone))
    }
    if (parts[0] === "test" && parts[1] === "queues" && parts.length === 2) {
      if (request.method !== "GET")
        return this.problem(
          404,
          "NOT_FOUND",
          `No Kill Bill route for ${request.method} ${url.pathname}`,
        )
      const raw = url.searchParams.get("timeoutSec")
      if (raw !== null && !/^-?\d+$/.test(raw))
        return this.problem(
          400,
          "INVALID_TIMEOUT",
          "timeoutSec must be an integer number of seconds",
        )
      const timeoutSec = raw === null ? 5 : Number(raw)
      return this.empty((await this.waitForQueues(timeoutSec)) ? 200 : 412)
    }
    if (parts[0] === "catalog") {
      if (request.method === "GET")
        return request.headers.get("accept")?.includes("xml")
          ? new Response(
              this.state.plans
                .list()
                .map(({ value }) => `<plan name="${value.name}" amount="${value.amount}"/>`)
                .join(""),
              { headers: { "content-type": "application/xml" } },
            )
          : this.json(this.catalogJson())
      const plans = Array.isArray(body.plans) ? body.plans : []
      for (const raw of plans) {
        const plan = object(raw)
        if (typeof plan.name === "string")
          this.state.plans.insert(plan.name, {
            name: plan.name,
            amount: money(plan.amount),
            ...(typeof plan.currency === "string" ? { currency: plan.currency } : {}),
            ...(typeof plan.intervalDays === "number" ? { intervalDays: plan.intervalDays } : {}),
          })
      }
      if (typeof body.raw === "string") {
        // Kill Bill 0.24.16 keeps one catalog version per effective date and tenant: uploading a
        // date the tenant already has is CatalogApiException 2080 (older and newer dates load).
        const effective = /<effectiveDate>\s*([^<]+?)\s*<\/effectiveDate>/i.exec(body.raw)?.[1]
        if (effective) {
          const versions = this.state.catalogVersions.get(tenantId)?.effectiveDates ?? []
          if (versions.includes(effective))
            return this.javaException(
              400,
              "org.killbill.billing.catalog.api.CatalogApiException",
              2080,
              `Invalid catalog for tenant : ${this.tenantRecordId(tenantId)}`,
            )
          this.state.catalogVersions.insert(tenantId, { effectiveDates: [...versions, effective] })
        }
        for (const plan of catalogPlans(body.raw)) this.state.plans.insert(plan.name, plan)
      }
      return this.empty(201)
    }
    if (parts[0] === "accounts" && parts.length === 1) {
      if (request.method === "GET") {
        const external = url.searchParams.get("externalKey")
        const account = external ? this.byExternal(external, tenantId) : undefined
        return account
          ? this.json(this.publicAccount(account))
          : this.accountKeyNotFound(external ?? "")
      }
      const externalKey =
        typeof body.externalKey === "string"
          ? body.externalKey
          : this.state.ids.next("account-key-", 24)
      // Kill Bill 0.24 maps ErrorCode.ACCOUNT_ALREADY_EXISTS (3000) to HTTP 409.
      const prior = this.byExternal(externalKey, tenantId)
      if (prior)
        return this.json(
          {
            className: "org.killbill.billing.account.api.AccountApiException",
            code: 3000,
            message: `Account already exists for key ${externalKey}`,
            causeClassName: null,
            causeMessage: null,
            stackTrace: [],
          },
          409,
        )
      if (typeof body.currency !== "string")
        return this.problem(400, "INVALID_ACCOUNT", "currency is required")
      const accountId = this.state.ids.next("acc-", 32)
      const account: Account = {
        ...body,
        accountId,
        tenantId,
        externalKey,
        currency: body.currency,
        timeZone: typeof body.timeZone === "string" ? body.timeZone : "UTC",
        referenceTime: new Date(this.now()).toISOString(),
        accountBalance: 0,
        accountCBA: 0,
      }
      this.state.accounts.insert(accountId, account)
      this.audit(request, "ACCOUNT", accountId)
      await this.emit("ACCOUNT_CREATION", "ACCOUNT", accountId, accountId, tenantId)
      return this.empty(201, { location: this.location(request, `/1.0/kb/accounts/${accountId}`) })
    }
    if (parts[0] === "accounts" && parts.length === 2 && request.method === "GET") {
      const account = this.account(parts[1] as string, tenantId)
      return account
        ? this.json(this.publicAccount(account))
        : this.objectDoesNotExist("ACCOUNT", parts[1] as string)
    }
    if (parts[0] === "accounts" && parts.length === 2 && request.method === "PUT") {
      const account = this.account(parts[1] as string, tenantId)
      if (!account) return this.objectDoesNotExist("ACCOUNT", parts[1] as string)
      const immutable = ["accountId", "externalKey", "currency", "timeZone", "referenceTime"]
      for (const field of immutable)
        if (field in body && body[field] !== account[field])
          return this.problem(400, "INVALID_ACCOUNT", `${field} cannot be changed`)
      const mutable = ["name", "email"]
      for (const field of Object.keys(body))
        if (!immutable.includes(field) && !mutable.includes(field))
          return this.problem(
            400,
            "UNSUPPORTED_ACCOUNT_UPDATE",
            `Updating ${field} is not modelled`,
          )
      const changes: Input = {}
      for (const field of mutable) {
        const value = body[field]
        if (
          value === undefined ||
          (value === null && url.searchParams.get("treatNullAsReset") !== "true")
        )
          continue
        if (value !== null && typeof value !== "string")
          return this.problem(400, "INVALID_ACCOUNT", `${field} must be a string or null`)
        changes[field] = value
      }
      this.state.accounts.insert(account.accountId, { ...account, ...changes })
      this.audit(request, "ACCOUNT", account.accountId)
      await this.emit("ACCOUNT_CHANGE", "ACCOUNT", account.accountId, account.accountId, tenantId)
      return this.empty()
    }
    const accountId = parts[0] === "accounts" ? (parts[1] as string) : undefined
    if (accountId && parts[2] === "overdue" && parts.length === 3 && request.method === "GET") {
      if (!this.account(accountId, tenantId)) return this.objectDoesNotExist("ACCOUNT", accountId)
      return this.json(this.overdueState(accountId))
    }
    if (accountId && parts[2] && !this.account(accountId, tenantId))
      return this.objectDoesNotExist("ACCOUNT", accountId)
    if (accountId && parts[2] === "paymentMethods") {
      if (!this.account(accountId, tenantId)) return this.objectDoesNotExist("ACCOUNT", accountId)
      if (request.method === "GET")
        return this.json(
          this.state.methods
            .list({ where: (m) => m.accountId === accountId })
            .map(({ value }) => value),
        )
      const externalKey =
        typeof body.externalKey === "string" ? body.externalKey : this.state.ids.next("pm-key-", 24)
      const prior = this.state.methods
        .list({
          where: (m) =>
            m.externalKey === externalKey && this.account(m.accountId, tenantId) !== undefined,
        })
        .map(({ value }) => value)[0]
      if (prior)
        return this.problem(400, "PAYMENT_METHOD_ALREADY_EXISTS", "Payment method already exists")
      const paymentMethodId = this.state.ids.next("pm-", 32)
      const makeDefault =
        url.searchParams.get("isDefault") === "true" ||
        this.state.methods.list({ where: (m) => m.accountId === accountId }).length === 0
      if (makeDefault)
        for (const { value } of this.state.methods.list({
          where: (m) => m.accountId === accountId,
        }))
          this.state.methods.insert(value.paymentMethodId, { ...value, isDefault: false })
      const method: PaymentMethod = {
        ...body,
        paymentMethodId,
        accountId,
        externalKey,
        pluginName: typeof body.pluginName === "string" ? body.pluginName : "__EXTERNAL_PAYMENT__",
        isDefault: makeDefault,
      }
      this.state.methods.insert(paymentMethodId, method)
      this.audit(request, "PAYMENT_METHOD", paymentMethodId)
      return this.empty(201, {
        location: this.location(request, `/1.0/kb/paymentMethods/${paymentMethodId}`),
      })
    }
    if (parts[0] === "paymentMethods") {
      const method = parts[1]
        ? this.state.methods.get(parts[1])
        : this.state.methods
            .list({ where: (m) => m.externalKey === url.searchParams.get("externalKey") })
            .map(({ value }) => value)[0]
      return method && this.account(method.accountId, tenantId)
        ? this.json({ auditLogs: [], ...method })
        : this.problem(404, "PAYMENT_METHOD_DOES_NOT_EXIST", "Payment method not found")
    }
    if (parts[0] === "subscriptions" && parts.length === 1 && request.method === "POST") {
      const inputs = Array.isArray(body) ? (body as unknown as Input[]) : [body]
      // 0.24 createSubscription locates the subscription, not the bundle.
      let createdSubscriptionId = ""
      for (const input of inputs) {
        if (
          typeof input.accountId !== "string" ||
          !this.account(input.accountId, tenantId) ||
          typeof input.planName !== "string"
        )
          return this.problem(
            400,
            "INVALID_SUBSCRIPTION",
            "valid accountId and planName are required",
          )
        // Kill Bill 0.24.10 with no catalog uploaded fails before it looks the plan up.
        if (this.state.plans.list().length === 0)
          return this.javaException(
            500,
            "java.lang.IllegalStateException",
            null,
            `No existing versions in the VersionedCatalog catalog for input date ${javaDate(this.now())}`,
          )
        if (!this.plan(input.planName)) {
          const message = `Could not find any plans named '${input.planName}'`
          return this.javaException(
            400,
            "org.killbill.billing.subscription.api.user.SubscriptionBaseApiException",
            2021,
            message,
            { className: "org.killbill.billing.catalog.api.CatalogApiException", message },
          )
        }
        const givenKey = typeof input.externalKey === "string" ? input.externalKey : undefined
        const subscriptionId = this.state.ids.next("sub-", 32)
        // Kill Bill 0.24.16 keys an unkeyed subscription and its bundle by their own ids.
        const externalKey = givenKey ?? subscriptionId
        if (
          this.state.subscriptions.list({
            where: (s) =>
              s.externalKey === externalKey && this.account(s.accountId, tenantId) !== undefined,
          }).length
        )
          return this.problem(
            400,
            "SUBSCRIPTION_ALREADY_EXISTS",
            "Subscription external key already exists",
          )
        const bundleId =
          typeof input.bundleId === "string" ? input.bundleId : this.state.ids.next("bundle-", 32)
        if (!this.state.bundles.has(bundleId))
          this.state.bundles.insert(bundleId, {
            bundleId,
            accountId: input.accountId,
            externalKey: givenKey ?? bundleId,
            subscriptions: [],
          })
        if (!createdSubscriptionId) createdSubscriptionId = subscriptionId
        const date = url.searchParams.get("entitlementDate") ?? isoDate(this.now())
        const subscription: Subscription = {
          ...input,
          subscriptionId,
          accountId: input.accountId,
          bundleId,
          externalKey,
          planName: input.planName,
          phaseType: typeof input.phaseType === "string" ? input.phaseType : "EVERGREEN",
          state: date > isoDate(this.now()) ? "PENDING" : "ACTIVE",
          startDate: date,
          // Kill Bill 0.24.16 reports chargedThroughDate null until the first invoice.
          createdAt: new Date(this.now()).toISOString(),
        }
        this.state.subscriptions.insert(subscriptionId, subscription)
        const bundle = this.state.bundles.get(bundleId)
        if (bundle)
          this.state.bundles.insert(bundleId, {
            ...bundle,
            subscriptions: [...bundle.subscriptions, subscriptionId],
          })
        this.audit(request, "SUBSCRIPTION", subscriptionId)
        await this.emit(
          "SUBSCRIPTION_CREATION",
          "SUBSCRIPTION",
          subscriptionId,
          input.accountId,
          tenantId,
        )
      }
      await this.billDue(tenantId)
      return this.empty(201, {
        location: this.location(request, `/1.0/kb/subscriptions/${createdSubscriptionId}`),
      })
    }
    if (parts[0] === "subscriptions" && parts[1]) {
      const subscription = this.state.subscriptions.get(parts[1])
      if (!subscription || !this.account(subscription.accountId, tenantId))
        return this.objectDoesNotExist("SUBSCRIPTION", parts[1])
      if (parts[2] === "block" && parts.length === 3) {
        if (request.method !== "POST")
          return this.problem(405, "METHOD_NOT_ALLOWED", "Use POST to add a blocking state")
        if (
          typeof body.stateName !== "string" ||
          !body.stateName ||
          typeof body.service !== "string" ||
          !body.service ||
          typeof body.isBlockBilling !== "boolean"
        )
          return this.problem(
            400,
            "INVALID_BLOCKING_STATE",
            "stateName, service and isBlockBilling are required",
          )
        if (
          (body.isBlockChange !== undefined && typeof body.isBlockChange !== "boolean") ||
          (body.isBlockEntitlement !== undefined && typeof body.isBlockEntitlement !== "boolean")
        )
          return this.problem(400, "INVALID_BLOCKING_STATE", "Blocking flags must be booleans")
        const effectiveDate = url.searchParams.get("requestedDate") ?? isoDate(this.now())
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) ||
          !Number.isFinite(Date.parse(effectiveDate)) ||
          isoDate(Date.parse(effectiveDate)) !== effectiveDate
        )
          return this.problem(400, "INVALID_DATE", "requestedDate must be a valid YYYY-MM-DD date")
        const next = {
          ...subscription,
          blockingStates: [
            ...(subscription.blockingStates ?? []),
            {
              stateName: body.stateName,
              service: body.service,
              isBlockBilling: body.isBlockBilling,
              isBlockEntitlement: body.isBlockEntitlement === true,
              isBlockChange: body.isBlockChange === true,
              effectiveDate,
              createdAt: new Date(this.now()).toISOString(),
            },
          ],
        }
        this.state.subscriptions.insert(subscription.subscriptionId, next)
        // Kill Bill re-runs the account's invoicing on a blocking state change: a pause credits
        // the rest of the period and a resume bills from that day.
        await this.billDue(tenantId, subscription.accountId)
        this.audit(request, "SUBSCRIPTION", subscription.subscriptionId)
        return this.empty(201)
      }
      if (parts[2] === "bcd" && parts.length === 3) {
        if (request.method !== "PUT")
          return this.problem(405, "METHOD_NOT_ALLOWED", "Use PUT to update the BCD")
        const day = body.billCycleDayLocal
        if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 31)
          return this.problem(
            400,
            "INVALID_BCD",
            "billCycleDayLocal must be an integer from 1 to 31",
          )
        // Kill Bill 0.24.16 accepts a BCD change on a non-monthly plan (204) and the subscription
        // reads back unchanged; the emulator records nothing for it.
        if ((this.plan(subscription.planName)?.intervalDays ?? 30) !== 30) return this.empty()
        const effective = url.searchParams.get("effectiveFromDate") ?? isoDate(this.now())
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(effective) ||
          !Number.isFinite(Date.parse(effective)) ||
          isoDate(Date.parse(effective)) !== effective
        )
          return this.problem(
            400,
            "INVALID_DATE",
            "effectiveFromDate must be a valid YYYY-MM-DD date",
          )
        if (
          effective < isoDate(this.now()) ||
          url.searchParams.has("forceNewBcdWithPastEffectiveDate")
        )
          return this.problem(
            400,
            "UNSUPPORTED_BCD",
            "The emulator does not model retroactive BCD changes",
          )
        if (
          body.subscriptionId !== undefined &&
          body.subscriptionId !== subscription.subscriptionId
        )
          return this.problem(400, "INVALID_SUBSCRIPTION", "subscriptionId must match the path")
        if (
          subscription.billCycleDayLocal !== undefined &&
          (subscription.billCycleDayLocal !== day ||
            subscription.bcdEffectiveFromDate !== effective)
        )
          return this.problem(
            400,
            "UNSUPPORTED_BCD",
            "The emulator supports only one BCD schedule change per subscription",
          )
        this.state.subscriptions.insert(subscription.subscriptionId, {
          ...subscription,
          billCycleDayLocal: day,
          bcdEffectiveFromDate: effective,
        })
        this.audit(request, "SUBSCRIPTION", subscription.subscriptionId)
        return this.empty()
      }
      if (parts[2] === "uncancel" && request.method === "PUT") {
        const next = { ...subscription, state: "ACTIVE" as const }
        delete next.cancelledDate
        delete next.billingEndDate
        delete next.cancelledAt
        delete next.billingStopFirst
        this.state.subscriptions.insert(subscription.subscriptionId, next)
        await this.emit(
          "SUBSCRIPTION_UNCANCEL",
          "SUBSCRIPTION",
          subscription.subscriptionId,
          subscription.accountId,
          tenantId,
        )
        return this.empty()
      }
      if (parts[2] === "undoChangePlan" && request.method === "PUT") {
        if (!subscription.pendingChangePlan)
          return this.json(
            {
              className: "org.killbill.billing.subscription.api.user.SubscriptionBaseApiException",
              code: 1071,
              message:
                "Subscription (billing) " +
                `${subscription.subscriptionId} does not have a pending change plan: ` +
                "Failed to undo change plan",
              causeClassName: null,
              causeMessage: null,
              stackTrace: [],
            },
            400,
          )
        const next = { ...subscription }
        delete next.pendingChangePlan
        this.state.subscriptions.insert(subscription.subscriptionId, next)
        return this.empty()
      }
      if (parts[2] === "changePlan" && request.method === "DELETE") {
        const next = { ...subscription }
        delete next.pendingChangePlan
        this.state.subscriptions.insert(subscription.subscriptionId, next)
        this.clearEntitlement(subscription.subscriptionId)
        return this.empty()
      }
      if (request.method === "GET") return this.json(this.subscriptionJson(subscription))
      if (request.method === "DELETE") {
        const rejected = await this.cancelSubscription(subscription, url, tenantId)
        if (rejected) return rejected
        await this.emit(
          "SUBSCRIPTION_CANCEL",
          "SUBSCRIPTION",
          subscription.subscriptionId,
          subscription.accountId,
          tenantId,
        )
        return this.empty()
      }
      if (request.method === "PUT") {
        const planName = typeof body.planName === "string" ? body.planName : ""
        if (!this.plan(planName)) return this.problem(400, "INVALID_PLAN", "Unknown plan")
        const immediate = (url.searchParams.get("billingPolicy") ?? "IMMEDIATE") === "IMMEDIATE"
        const next = immediate
          ? { ...subscription, planName }
          : { ...subscription, pendingChangePlan: planName }
        this.state.subscriptions.insert(subscription.subscriptionId, next)
        if (immediate) this.clearEntitlement(subscription.subscriptionId)
        else this.scheduleEntitlement(next)
        await this.emit(
          "SUBSCRIPTION_CHANGE",
          "SUBSCRIPTION",
          subscription.subscriptionId,
          subscription.accountId,
          tenantId,
        )
        return this.empty()
      }
    }
    if (accountId && parts[2] === "bundles" && request.method === "GET")
      return this.json(
        this.state.bundles
          .list({ order: "oldest", where: (b) => b.accountId === accountId })
          .map(({ value }) => {
            const subscriptions = value.subscriptions
              .map((id) => this.state.subscriptions.get(id))
              .filter((row): row is Subscription => row !== undefined)
              .map((row) => this.subscriptionJson(row))
            // Kill Bill 0.24.16 BundleJson: the bundle's events in a timeline beside its subscriptions.
            return {
              auditLogs: [],
              ...value,
              subscriptions,
              timeline: {
                auditLogs: [],
                accountId: value.accountId,
                bundleId: value.bundleId,
                events: subscriptions.flatMap((row) => row.events),
                externalKey: value.externalKey,
              },
            }
          }),
      )
    if (accountId && parts[2] === "invoicePayments" && request.method === "POST") {
      if (url.searchParams.has("paymentAmount") || url.searchParams.has("pluginProperty"))
        return this.problem(
          400,
          "UNSUPPORTED_INVOICE_PAYMENT",
          "Emulator account payments support full balances without plugin properties only",
        )
      const targetDate = url.searchParams.get("targetDate") ?? isoDate(this.now())
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(targetDate) ||
        !Number.isFinite(Date.parse(targetDate)) ||
        isoDate(Date.parse(targetDate)) !== targetDate
      )
        return this.problem(400, "INVALID_DATE", "targetDate must be a valid YYYY-MM-DD date")
      const unpaid = this.state.invoices.list({
        where: (invoice) =>
          invoice.accountId === accountId &&
          invoice.status !== "VOID" &&
          invoice.balance > 0 &&
          invoice.targetDate <= targetDate,
      })
      if (unpaid.length === 0) return this.empty()
      const external = url.searchParams.get("externalPayment") === "true"
      const methodId = external
        ? this.externalPaymentMethod(accountId).paymentMethodId
        : (url.searchParams.get("paymentMethodId") ??
          this.defaultPaymentMethod(accountId)?.paymentMethodId)
      for (const { value: invoice } of unpaid) {
        const owed = this.state.invoices.get(invoice.invoiceId)?.balance ?? 0
        if (owed > 0)
          await this.pay(
            accountId,
            tenantId,
            { amount: owed, transactionType: "PURCHASE" },
            invoice.invoiceId,
            methodId,
            external,
          )
      }
      return this.empty(201, {
        location: this.location(request, `/1.0/kb/accounts/${accountId}/invoices`),
      })
    }
    if (accountId && parts[2] === "invoices" && request.method === "GET") {
      const components = url.searchParams.get("includeInvoiceComponents") === "true"
      return this.json(
        this.state.invoices
          .list({ order: "oldest", where: (i) => i.accountId === accountId })
          .map(({ value }) => this.invoiceJson(value, components)),
      )
    }
    if (accountId && parts[2] === "tags") {
      if (request.method === "GET")
        return this.json(
          this.state.tags
            .list({ where: (t) => t.objectId === accountId })
            .map(({ value }) => value),
        )
      const ids = Array.isArray(body)
        ? body
        : Array.isArray(body.tagDefinitionIds)
          ? body.tagDefinitionIds
          : []
      for (const id of ids)
        if (typeof id === "string")
          this.state.tags.insert(`${accountId}\0${id}`, {
            objectId: accountId,
            tagDefinitionId: id,
          })
      return this.empty(201)
    }
    if (
      parts[0] === "invoices" &&
      parts[1] === "charges" &&
      parts[2] &&
      request.method === "POST"
    ) {
      const inputs = Array.isArray(body) ? (body as unknown as Input[]) : [body]
      const invoice = await this.createInvoice(parts[2], tenantId, inputs)
      return invoice
        ? this.empty(201, {
            location: this.location(request, `/1.0/kb/invoices/${invoice.invoiceId}`),
          })
        : this.objectDoesNotExist("ACCOUNT", parts[2])
    }
    if (parts[0] === "credits" && request.method === "POST") {
      const inputs = Array.isArray(body) ? (body as unknown as Input[]) : [body]
      const account = inputs[0]?.accountId
      if (typeof account !== "string")
        return this.problem(400, "INVALID_CREDIT", "accountId required")
      // Kill Bill 0.24.16: each credit is a CREDIT_ADJ (-amount) and a CBA_ADJ (+amount) on a new
      // invoice, COMMITTED with autoCommit=true and DRAFT otherwise; the answer is 200 with the
      // CREDIT_ADJ items, their amounts positive.
      const today = isoDate(this.now())
      const invoice = await this.createInvoice(
        account,
        tenantId,
        inputs.flatMap((item) => {
          const amount = Math.abs(money(item.amount))
          return [
            {
              ...item,
              itemType: "CREDIT_ADJ",
              amount: -amount,
              startDate: today,
              endDate: today,
            },
            {
              itemType: "CBA_ADJ",
              amount,
              description: "Adjustment (account credit)",
              startDate: today,
              endDate: today,
            },
          ]
        }),
        "Credit",
        {
          status: url.searchParams.get("autoCommit") === "true" ? "COMMITTED" : "DRAFT",
          useCredit: false,
        },
      )
      if (!invoice) return this.objectDoesNotExist("ACCOUNT", account)
      return this.json(
        invoice.items
          .filter((item) => item.itemType === "CREDIT_ADJ")
          .map((item) => ({ ...this.invoiceItemJson(item), amount: -item.amount })),
      )
    }
    if (parts[0] === "invoices" && parts.length === 1 && request.method === "POST")
      return this.invoiceThrough(request, url, tenantId)
    if (parts[0] === "paymentTransactions" && parts.length === 1 && request.method === "GET") {
      const key = url.searchParams.get("transactionExternalKey") ?? ""
      const payment = this.state.payments
        .list({
          where: (row) =>
            this.account(row.accountId, tenantId) !== undefined &&
            row.transactions.some((transaction) => transaction.transactionExternalKey === key),
        })
        .map(({ value }) => value)[0]
      if (!payment)
        return this.javaException(
          404,
          "org.killbill.billing.payment.api.PaymentApiException",
          7020,
          `Payment ${key} does not exist`,
        )
      return this.json(this.paymentJson(payment))
    }
    if (parts[0] === "invoices" && parts[1] === "dryRun" && request.method === "POST") {
      const previewAccountId = url.searchParams.get("accountId") ?? ""
      const account = this.account(previewAccountId, tenantId)
      if (!account) return this.objectDoesNotExist("ACCOUNT", previewAccountId)
      if (
        body.dryRunAction !== undefined ||
        (body.dryRunType !== undefined && body.dryRunType !== "TARGET_DATE")
      )
        return this.problem(
          400,
          "UNSUPPORTED_DRY_RUN",
          "Emulator supports TARGET_DATE previews only",
        )
      const targetDate = url.searchParams.get("targetDate") ?? isoDate(this.now())
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(targetDate) ||
        !Number.isFinite(Date.parse(targetDate)) ||
        isoDate(Date.parse(targetDate)) !== targetDate
      )
        return this.problem(400, "INVALID_DATE", "targetDate must be a valid YYYY-MM-DD date")
      const items: InvoiceItem[] = []
      for (const { value: subscription } of this.state.subscriptions.list({
        where: (value) => value.accountId === previewAccountId && this.billable(value, targetDate),
      })) {
        if (this.subscriptionBlocked(subscription, targetDate, "billing")) continue
        const planName = subscription.pendingChangePlan ?? subscription.planName
        const plan = this.plan(planName)
        if (!plan) continue
        // Preview the due recurring charges without consuming IDs, advancing the clock,
        // applying scheduled changes, creating invoices or sending payment notifications.
        const due = this.duePeriods({ ...subscription, planName }, plan, targetDate).items
        const bound = this.safetyBound(subscription, planName, due, isoDate(this.now()))
        if (bound) return bound
        for (const [index, item] of due.entries())
          items.push({
            ...item,
            invoiceItemId: `preview-item-${subscription.subscriptionId}${index === 0 ? "" : `-${index}`}`,
            invoiceId: "preview",
            accountId: previewAccountId,
            currency: plan.currency ?? account.currency,
          } as InvoiceItem)
      }
      if (items.length === 0) return this.empty()
      const amount = money(items.reduce((total, item) => total + item.amount, 0))
      return this.json({
        invoiceId: "preview",
        accountId: previewAccountId,
        invoiceNumber: null,
        invoiceDate: isoDate(this.now()),
        targetDate,
        currency: account.currency,
        status: "COMMITTED",
        amount,
        balance: amount,
        creditAdj: 0,
        refundAdj: 0,
        items,
      })
    }
    if (parts[0] === "invoices" && parts[1]) {
      const invoice = this.state.invoices.get(parts[1])
      if (!invoice || !this.account(invoice.accountId, tenantId))
        return this.objectDoesNotExist("INVOICE", parts[1])
      if (parts.length === 2 && request.method === "POST") {
        const item = invoice.items.find(
          (candidate) => candidate.invoiceItemId === body.invoiceItemId,
        )
        if (
          !item ||
          body.accountId !== invoice.accountId ||
          invoice.status === "VOID" ||
          item.amount <= 0 ||
          item.itemType === "ITEM_ADJ"
        )
          return this.problem(
            400,
            "INVALID_INVOICE_ITEM_ADJUSTMENT",
            "A positive invoice item and its accountId are required",
          )
        const adjusted = invoice.items
          .filter(
            (candidate) =>
              candidate.itemType === "ITEM_ADJ" &&
              candidate.linkedInvoiceItemId === item.invoiceItemId,
          )
          .reduce((total, candidate) => total + candidate.amount, 0)
        const remaining = money(item.amount + adjusted)
        const amount = body.amount === undefined ? remaining : body.amount
        if (
          typeof amount !== "number" ||
          !Number.isFinite(amount) ||
          amount <= 0 ||
          money(amount) <= 0 ||
          money(amount) > remaining ||
          (body.currency !== undefined && body.currency !== item.currency)
        )
          return this.problem(
            400,
            "INVALID_INVOICE_ITEM_ADJUSTMENT",
            "Adjustment must be positive, use the item currency, and not exceed its remaining amount",
          )
        const adjustmentAudit = this.stamp()
        const adjustment: InvoiceItem = {
          invoiceItemId: this.state.ids.next("item-", 32),
          invoiceId: invoice.invoiceId,
          accountId: invoice.accountId,
          itemType: "ITEM_ADJ",
          amount: -money(amount),
          currency: item.currency,
          description:
            typeof body.description === "string" ? body.description : "Invoice item adjustment",
          startDate: isoDate(this.now()),
          linkedInvoiceItemId: item.invoiceItemId,
          ...(adjustmentAudit ? { audit: adjustmentAudit } : {}),
        }
        // Kill Bill 0.24.16 (parity scenario `item-adjust-paid`): what the adjustment takes
        // beyond the open balance becomes account credit (CBA_ADJ), so the balance stays at 0.
        const credit = money(money(amount) - Math.max(invoice.balance, 0))
        const cba: InvoiceItem[] =
          credit > 0
            ? [
                {
                  invoiceItemId: this.state.ids.next("item-", 32),
                  invoiceId: invoice.invoiceId,
                  accountId: invoice.accountId,
                  itemType: "CBA_ADJ",
                  amount: credit,
                  currency: item.currency,
                  description: "Adjustment (account credit)",
                  startDate: isoDate(this.now()),
                  ...(adjustmentAudit ? { audit: adjustmentAudit } : {}),
                },
              ]
            : []
        this.state.invoices.insert(invoice.invoiceId, {
          ...invoice,
          amount: money(invoice.amount - money(amount)),
          balance: money(invoice.balance - money(amount) + Math.max(credit, 0)),
          creditAdj: money(invoice.creditAdj + Math.max(credit, 0)),
          items: [...invoice.items, adjustment, ...cba],
        })
        return this.empty(201, {
          location: this.location(request, `/1.0/kb/invoices/${invoice.invoiceId}`),
        })
      }
      if (parts[2] === "voidInvoice" && request.method === "PUT")
        return this.voidInvoice(invoice, tenantId)
      // Kill Bill 0.24.16: 204, and a committed credit becomes account credit (parity scenario
      // `account-credit-draft`).
      if (parts[2] === "commitInvoice" && request.method === "PUT") {
        if (invoice.status === "DRAFT")
          this.state.invoices.insert(invoice.invoiceId, { ...invoice, status: "COMMITTED" })
        return this.empty()
      }
      if (parts[2] === "payments") {
        if (request.method === "GET")
          return this.json(
            this.state.payments
              .list({ where: (payment) => payment.invoiceId === invoice.invoiceId })
              .map(({ value }) => this.invoicePayment(value, invoice.invoiceId)),
          )
        const externalPayment = url.searchParams.get("externalPayment") === "true"
        if (externalPayment && typeof body.paymentMethodId === "string")
          return this.problem(
            400,
            "INVALID_PAYMENT",
            "InvoicePaymentJson should not contain a paymentMethodId when this is an external payment",
          )
        // Kill Bill 0.24.10 takes no payment on an invoice with nothing owed (204) and refuses an
        // amount above the balance (PaymentApiException 7199), for external and method payments.
        if (invoice.balance <= 0) return this.empty()
        const requestedAmount = body.purchasedAmount ?? body.amount
        if (requestedAmount !== undefined && money(requestedAmount) > invoice.balance)
          return this.json(
            {
              className: "org.killbill.billing.payment.api.PaymentApiException",
              code: 7199,
              message:
                `Plugin exception Invalid amount '${String(requestedAmount)}' for invoice ` +
                `'${invoice.invoiceId}': invoice balance is = '${invoice.balance.toFixed(2)}'`,
              causeClassName: null,
              causeMessage: null,
              stackTrace: [],
            },
            400,
          )
        const payerId = typeof body.accountId === "string" ? body.accountId : invoice.accountId
        const requestedMethod =
          typeof body.paymentMethodId === "string" ? body.paymentMethodId : undefined
        const paymentMethodId = externalPayment
          ? this.account(payerId, tenantId)
            ? this.externalPaymentMethod(payerId).paymentMethodId
            : undefined
          : (requestedMethod ?? this.defaultPaymentMethod(payerId)?.paymentMethodId)
        const payment = await this.pay(
          payerId,
          tenantId,
          {
            ...body,
            amount: requestedAmount ?? invoice.balance,
            transactionType: externalPayment ? "PURCHASE" : (body.transactionType ?? "PURCHASE"),
          },
          invoice.invoiceId,
          paymentMethodId,
          externalPayment,
        )
        return payment
          ? this.empty(201, {
              location: this.location(request, `/1.0/kb/payments/${payment.paymentId}`),
            })
          : this.problem(400, "PAYMENT_FAILED", "Payment could not be created")
      }
      if (request.method === "GET") return this.json(this.invoiceJson(invoice))
      if (request.method === "DELETE") {
        if (this.netCollected(invoice.invoiceId) !== 0)
          return this.problem(409, "INVOICE_NOT_WRITABLE", "Paid invoice cannot be voided")
        this.state.invoices.insert(invoice.invoiceId, { ...invoice, status: "VOID", balance: 0 })
        await this.emit("INVOICE_VOID", "INVOICE", invoice.invoiceId, invoice.accountId, tenantId)
        return this.empty()
      }
    }
    if (parts[0] === "accounts" && parts[1] === "payments" && request.method === "POST") {
      const account = url.searchParams.get("externalKey")
        ? this.byExternal(url.searchParams.get("externalKey") as string, tenantId)
        : undefined
      if (!account) return this.accountKeyNotFound(url.searchParams.get("externalKey") ?? "")
      const payment = await this.pay(
        account.accountId,
        tenantId,
        body,
        undefined,
        url.searchParams.get("paymentMethodId") ?? undefined,
      )
      return payment
        ? this.empty(201, {
            location: this.location(request, `/1.0/kb/payments/${payment.paymentId}`),
          })
        : this.problem(400, "PAYMENT_FAILED", "Payment failed")
    }
    if (parts[0] === "invoicePayments" && parts[1]) {
      const payment = this.state.payments.get(parts[1])
      if (!payment) return this.problem(404, "PAYMENT_DOES_NOT_EXIST", "Payment not found")
      if (parts[2] === "refunds" && request.method === "POST")
        return this.refundInvoicePayment(request, url, payment, body, tenantId)
      if (request.method === "GET" && !parts[2]) return this.json(this.invoicePayment(payment))
    }
    if (parts[0] === "payments" && parts[1]) {
      const payment = this.state.payments.get(parts[1])
      if (!payment || !this.account(payment.accountId, tenantId))
        return this.problem(404, "PAYMENT_DOES_NOT_EXIST", "Payment not found")
      if (parts[2] === "refunds" && request.method === "POST") {
        const amount = money(body.amount ?? payment.purchasedAmount - payment.refundedAmount)
        if (amount <= 0 || amount > payment.purchasedAmount - payment.refundedAmount)
          return this.problem(
            400,
            "INVALID_REFUND_AMOUNT",
            "Refund amount exceeds purchased amount",
          )
        const transaction = this.transaction(
          payment,
          "REFUND",
          amount,
          "SUCCESS",
          typeof body.transactionExternalKey === "string" ? body.transactionExternalKey : undefined,
        )
        const next = {
          ...payment,
          refundedAmount: money(payment.refundedAmount + amount),
          transactions: [...payment.transactions, transaction],
        }
        this.state.payments.insert(payment.paymentId, next)
        // The default invoice payment control plugin reopens the invoice by the refund.
        this.reopenInvoice(payment, amount, false)
        await this.emit("PAYMENT_REFUND", "PAYMENT", payment.paymentId, payment.accountId, tenantId)
        return this.empty(201, {
          location: this.location(request, `/1.0/kb/payments/${payment.paymentId}`),
        })
      }
      if (request.method === "GET") return this.json(this.paymentJson(payment))
    }
    return this.problem(
      404,
      "NOT_FOUND",
      `No Kill Bill route for ${request.method} ${url.pathname}`,
    )
  }
}
