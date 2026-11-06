import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
/** Who wrote a row: Kill Bill's audit columns, from the writing request's headers. */
export type AuditStamp = {
  changeDate: string
  changedBy: string
  comments: string | null
  reasonCode: string | null
  userToken: string
}
export type Account = Record<string, unknown> & {
  accountId: string
  tenantId: string
  externalKey: string
  currency: string
  timeZone: string
  referenceTime: string
  accountBalance: number
  accountCBA: number
}
/** Kill Bill tenant. `callbacks` is the single-value PUSH_NOTIFICATION_CB list. */
export type Tenant = {
  tenantId: string
  externalKey: string
  apiKey: string
  apiSecret: string
  callbacks: string[]
}
export type PaymentMethod = Record<string, unknown> & {
  paymentMethodId: string
  accountId: string
  externalKey: string
  pluginName: string
  isDefault: boolean
}
export type Subscription = Record<string, unknown> & {
  subscriptionId: string
  accountId: string
  bundleId: string
  externalKey: string
  planName: string
  phaseType: string
  state: "PENDING" | "ACTIVE" | "CANCELLED"
  startDate: string
  chargedThroughDate?: string
  /** The day entitlement stops (Kill Bill's cancelledDate). */
  cancelledDate?: string
  /** The day billing stops (Kill Bill's billingEndDate); renewals from it on are not billed. */
  billingEndDate?: string
  /**
   * Plan changes in the order they were requested: applied ones and those still ahead (a requested
   * date, or the period end). Kill Bill reports each as a CHANGE event.
   */
  planChanges?: {
    effectiveDate: string
    planName: string
    fromPlanName: string
    /** When the request was made: an immediate change reports this instant. */
    createdAt: string
    endOfTerm?: boolean
    /** Requested with billingPolicy=IMMEDIATE: dated by the request instant. */
    immediate?: boolean
    applied?: boolean
  }[]
  /** The day the latest applied plan change took effect: periods align to its month. */
  billingAnchorDate?: string
  /** The day a billing pause took effect and credited the rest of the billed period. */
  billingPausedFrom?: string
  /** When the cancel request ran: a stop on that day reads as this instant. */
  cancelledAt?: string
  /** Billing stopped at the requested instant before entitlement (STOP_BILLING listed first). */
  billingStopFirst?: boolean
  pendingChangePlan?: string
  /** The latest BCD change: its day and effective date (earlier ones are in `bcdChanges`). */
  billCycleDayLocal?: number
  bcdEffectiveFromDate?: string
  /** Every BCD change, in effective-date order; each takes over from its effective date. */
  bcdChanges?: { day: number; effectiveFrom: string }[]
  blockingStates?: {
    stateName: string
    service: string
    isBlockBilling: boolean
    isBlockEntitlement?: boolean
    isBlockChange?: boolean
    effectiveDate: string
    /** When the state was added, for the subscription's event list. */
    createdAt?: string
    /** Added with a requestedDate: its event is dated that day, not when it was added. */
    requested?: boolean
  }[]
  /** When the subscription was created: Kill Bill reports startDate as this instant. */
  createdAt?: string
  /** Phase prices sent on create. Kill Bill 0.24 echoes these on GET. */
  priceOverrides?: Record<string, unknown>[]
}
export type Bundle = {
  bundleId: string
  accountId: string
  externalKey: string
  subscriptions: string[]
}
export type InvoiceItem = Record<string, unknown> & {
  audit?: AuditStamp
  invoiceItemId: string
  invoiceId: string
  accountId: string
  itemType: string
  amount: number
  currency: string
  description: string
  startDate: string
  linkedInvoiceItemId?: string
  subscriptionId?: string
  planName?: string
}
export type Invoice = {
  audit?: AuditStamp
  invoiceId: string
  accountId: string
  invoiceNumber: string
  invoiceDate: string
  targetDate: string
  currency: string
  status: "COMMITTED" | "DRAFT" | "VOID"
  amount: number
  balance: number
  creditAdj: number
  refundAdj: number
  items: InvoiceItem[]
}
export type Transaction = {
  audit?: AuditStamp
  transactionId: string
  paymentId: string
  transactionExternalKey: string
  transactionType: "AUTHORIZE" | "CAPTURE" | "PURCHASE" | "VOID" | "CREDIT" | "REFUND"
  effectiveDate: string
  status: "SUCCESS" | "PAYMENT_FAILURE" | "PENDING"
  amount: number
  currency: string
  gatewayErrorCode?: string
  gatewayErrorMsg?: string
}
export type Payment = {
  audit?: AuditStamp
  paymentId: string
  accountId: string
  invoiceId?: string
  paymentNumber: string
  paymentExternalKey: string
  authAmount: number
  capturedAmount: number
  purchasedAmount: number
  refundedAmount: number
  creditedAmount: number
  currency: string
  paymentMethodId?: string
  /** Credit created by an external invoice-payment refund, linked to the purchase. */
  linkedPaymentId?: string
  transactions: Transaction[]
  paymentAttempts: Record<string, unknown>[]
}
export type CatalogPlan = {
  name: string
  amount: number
  currency?: string
  intervalDays?: number
  /** Catalog product of the plan (`<product>` in catalog XML); the plan name when not given. */
  product?: string
}
export type QueuedNotification = {
  id: string
  effectiveDate: string
  kind: string
  /** A push notification to retry: where, what, and how many attempts it has had. */
  delivery?: PushDelivery
}
export type PushDelivery = { url: string; body: string; attempts: number }
export type QueuedBusEvent = {
  id: string
  eventType: string
  /** A push notification waiting for its first delivery. */
  delivery?: PushDelivery
}
export type Audit = {
  id: string
  objectType: string
  objectId: string
  createdBy: string
  reason?: string
  comment?: string
  createdAt: string
}
export class KillBillState {
  readonly accounts: Collection<Account>
  readonly methods: Collection<PaymentMethod>
  readonly subscriptions: Collection<Subscription>
  readonly bundles: Collection<Bundle>
  readonly invoices: Collection<Invoice>
  readonly payments: Collection<Payment>
  readonly tags: Collection<{ objectId: string; tagDefinitionId: string }>
  readonly plans: Collection<CatalogPlan>
  /** Effective dates of the catalog versions each tenant uploaded, keyed by tenantId. */
  readonly catalogVersions: Collection<{ effectiveDates: string[] }>
  readonly audits: Collection<Audit>
  readonly notifications: Collection<QueuedNotification>
  readonly busEvents: Collection<QueuedBusEvent>
  readonly settings: Collection<{ clockMs?: number; declineNext: boolean; pendingNext: boolean }>
  readonly tenants: Collection<Tenant>
  readonly ids: IdSequence
  constructor(sqlite: SqliteClient, namespace: string) {
    this.accounts = new Collection(sqlite, namespace, "kb_accounts")
    this.methods = new Collection(sqlite, namespace, "kb_methods")
    this.subscriptions = new Collection(sqlite, namespace, "kb_subscriptions")
    this.bundles = new Collection(sqlite, namespace, "kb_bundles")
    this.invoices = new Collection(sqlite, namespace, "kb_invoices")
    this.payments = new Collection(sqlite, namespace, "kb_payments")
    this.tags = new Collection(sqlite, namespace, "kb_tags")
    this.plans = new Collection(sqlite, namespace, "kb_plans")
    this.catalogVersions = new Collection(sqlite, namespace, "kb_catalog_versions")
    this.audits = new Collection(sqlite, namespace, "kb_audits")
    this.notifications = new Collection(sqlite, namespace, "kb_notifications")
    this.busEvents = new Collection(sqlite, namespace, "kb_bus_events")
    this.settings = new Collection(sqlite, namespace, "kb_settings")
    this.tenants = new Collection(sqlite, namespace, "kb_tenants")
    this.ids = new IdSequence(sqlite, namespace, "killbill")
  }
}
