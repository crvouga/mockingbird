import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type Account = Record<string, unknown> & {
  accountId: string
  externalKey: string
  currency: string
  timeZone: string
  referenceTime: string
  accountBalance: number
  accountCBA: number
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
  state: "PENDING" | "ACTIVE" | "CANCELLED"
  startDate: string
  chargedThroughDate?: string
  cancelledDate?: string
  pendingChangePlan?: string
}
export type Bundle = {
  bundleId: string
  accountId: string
  externalKey: string
  subscriptions: string[]
}
export type InvoiceItem = Record<string, unknown> & {
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
  invoiceId: string
  accountId: string
  invoiceNumber: string
  invoiceDate: string
  targetDate: string
  currency: string
  status: "COMMITTED" | "VOID"
  amount: number
  balance: number
  creditAdj: number
  refundAdj: number
  items: InvoiceItem[]
}
export type Transaction = {
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
  transactions: Transaction[]
  paymentAttempts: Record<string, unknown>[]
}
export type CatalogPlan = { name: string; amount: number; currency?: string; intervalDays?: number }
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
  readonly audits: Collection<Audit>
  readonly settings: Collection<{ clockMs?: number; declineNext: boolean; pendingNext: boolean }>
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
    this.audits = new Collection(sqlite, namespace, "kb_audits")
    this.settings = new Collection(sqlite, namespace, "kb_settings")
    this.ids = new IdSequence(sqlite, namespace, "killbill")
  }
}
