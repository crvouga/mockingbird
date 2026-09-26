import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  jsonRes,
  type OperationContext,
  opaqueToken,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import {
  addPeriod,
  type Priced,
  previewDetails,
  previewLineItem,
  samePeriod,
  transactionDetails,
} from "./billing.js"
import type {
  AddressRecord,
  BillingDetails,
  BusinessRecord,
  CollectionMode,
  CustomData,
  CustomerRecord,
  EventRecord,
  LineItem,
  PaymentAttempt,
  PendingCharge,
  Period,
  PriceRecord,
  ProductRecord,
  ScheduledChange,
  Status,
  SubscriptionItem,
  SubscriptionRecord,
  TimePeriod,
  TransactionOrigin,
  TransactionRecord,
  TransactionStatus,
  TrialPeriod,
} from "./entities.js"
import {
  badRequest,
  errorBody,
  type FieldError,
  invalidField,
  notFound,
  PaddleError,
} from "./errors.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { listParam, paginate } from "./lists.js"
import { PaddleState } from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type {
  AddressRecord,
  BillingDetails,
  BusinessRecord,
  CollectionMode,
  CustomData,
  CustomerRecord,
  EventRecord,
  LineItem,
  PaymentAttempt,
  Period,
  PreviewDetails,
  PriceRecord,
  ProductRecord,
  ScheduledChange,
  SubscriptionItem,
  SubscriptionRecord,
  SubscriptionStatus,
  TimePeriod,
  TransactionItem,
  TransactionOrigin,
  TransactionRecord,
  TransactionStatus,
  TrialPeriod,
} from "./entities.js"
export { PaddleError } from "./errors.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export { ID_PREFIX, PaddleState } from "./state.js"

export const PADDLE_NAMESPACE = "paddle"

/** How long a customer auth token (`POST /customers/{id}/auth-token`) is advertised to live. */
export const AUTH_TOKEN_TTL_MS = 30 * 60_000

const DEFAULT_PER_PAGE = 50
const MAX_PER_PAGE = 200
const TRANSACTIONS_PER_PAGE = 30

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"]
const TRANSACTION_INCLUDES = ["customer", "address", "business"]
const SUBSCRIPTION_INCLUDES = ["next_transaction", "recurring_transaction_details"]

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const nullableStr = (value: unknown, fallback: string | null): string | null =>
  value === undefined ? fallback : typeof value === "string" ? value : null

const customData = (value: unknown, fallback: CustomData): CustomData =>
  value === undefined ? fallback : isRecord(value) ? value : null

/** `Idempotent` json response with Paddle's `{data, meta}` envelope. */
const envelope = (status: number, data: unknown, requestId: string, pagination?: unknown) =>
  jsonRes(status, {
    data,
    meta: { request_id: requestId, ...(pagination ? { pagination } : {}) },
  })

const hexUuid = (token: string) => {
  const hex = [...token].map((c) => (c.charCodeAt(0) % 16).toString(16)).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** What `POST /__admin/checkout` accepts: a hosted-checkout completion, in one call. */
export type CheckoutInput = {
  /** An existing customer, or an email to find or create one by. */
  customer_id?: string
  email?: string
  name?: string
  /** An existing address of the customer, or a country to create one for. Default `US`. */
  address_id?: string
  country_code?: string
  postal_code?: string
  business_id?: string
  items: { price_id: string; quantity?: number }[]
  custom_data?: CustomData
  currency_code?: string
}

export type CardInput = {
  type?: string
  last4?: string
  expiry_month?: number
  expiry_year?: number
  cardholder_name?: string
}

export type PaddleAPIOptions = APIOptions & {
  /** The public namespace name, for `/ns/<name>` in `meta.pagination.next` and management URLs. */
  publicNamespace?: string
  /**
   * The default payment link: a `ready` automatic-collection transaction gets
   * `checkout.url = <paymentLink>?_ptxn=<id>`. Default none (`checkout.url` is `null`).
   */
  paymentLink?: string
  /** Called with every event the account produces (the body a webhook would carry). */
  onEvent?: (event: EventRecord) => void
  /**
   * Seed the fixture account (`seedFixtures`) on construction when the namespace is empty, and
   * again after every `reset()`. Fixture events are recorded (`GET /events`) but not passed to
   * `onEvent`: they are the account's pre-existing state, not new activity.
   */
  fixtures?: boolean
}

type TransactionInput = {
  items?: unknown
  status?: unknown
  customer_id?: unknown
  address_id?: unknown
  business_id?: unknown
  currency_code?: unknown
  collection_mode?: unknown
  billing_details?: unknown
  billing_period?: unknown
  custom_data?: unknown
  checkout?: unknown
}

/**
 * Stateful mock of the Paddle Billing API. Catalog and customer records behave as Paddle's do;
 * transactions carry computed totals (no tax, no discounts); subscriptions are created when a
 * transaction with recurring prices is paid, which the admin routes simulate (`payTransaction`,
 * `checkout`), and renewed or failed on demand (`renewSubscription`, `failPayment`).
 */
export class PaddleAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: PaddleState
  private readonly service: Service
  private readonly now: () => number
  private readonly publicNamespace: string | undefined
  private readonly paymentLink: string | undefined
  private readonly onEvent: PaddleAPIOptions["onEvent"]
  private readonly fixtures: boolean
  private readonly requestIds = new WeakMap<Request, string>()
  private requestCounter = 0
  /** While seeding fixtures: events are recorded but not published. */
  private seeding = false

  constructor(options: PaddleAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? PADDLE_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.publicNamespace = options.publicNamespace
    this.paymentLink = options.paymentLink
    this.onEvent = options.onEvent
    this.fixtures = options.fixtures === true
    this.state = new PaddleState(sqlite, namespace)
    const handlers = defineOperations<SupportedOperationId>({
      ListCustomers: (c) => this.listCustomers(c),
      CreateCustomer: (c) => this.createCustomerOp(c),
      GetCustomer: (c) => this.getCustomer(c),
      UpdateCustomer: (c) => this.updateCustomer(c),
      GetCustomerCreditBalances: (c) => this.creditBalances(c),
      CreateCustomerAuthToken: (c) => this.authToken(c),
      ListAddresses: (c) => this.listAddresses(c),
      CreateAddress: (c) => this.createAddressOp(c),
      GetAddress: (c) => this.getAddress(c),
      UpdateAddress: (c) => this.updateAddress(c),
      ListBusinesses: (c) => this.listBusinesses(c),
      CreateBusiness: (c) => this.createBusinessOp(c),
      GetBusiness: (c) => this.getBusiness(c),
      UpdateBusiness: (c) => this.updateBusiness(c),
      ListProducts: (c) => this.listProducts(c),
      CreateProduct: (c) => this.createProductOp(c),
      GetProduct: (c) => this.getProduct(c),
      UpdateProduct: (c) => this.updateProduct(c),
      ListPrices: (c) => this.listPrices(c),
      CreatePrice: (c) => this.createPriceOp(c),
      GetPrice: (c) => this.getPrice(c),
      UpdatePrice: (c) => this.updatePrice(c),
      ListTransactions: (c) => this.listTransactions(c),
      CreateTransaction: (c) => this.createTransactionOp(c),
      PreviewTransaction: (c) => this.previewTransaction(c),
      GetTransaction: (c) => this.getTransaction(c),
      UpdateTransaction: (c) => this.updateTransaction(c),
      GetTransactionInvoice: (c) => this.transactionInvoice(c),
      ListSubscriptions: (c) => this.listSubscriptions(c),
      GetSubscription: (c) => this.getSubscription(c),
      UpdateSubscription: (c) => this.updateSubscription(c),
      ActivateSubscription: (c) => this.activateSubscription(c),
      PauseSubscription: (c) => this.pauseSubscription(c),
      ResumeSubscription: (c) => this.resumeSubscription(c),
      CancelSubscription: (c) => this.cancelSubscription(c),
      CreateSubscriptionCharge: (c) => this.chargeSubscription(c),
      ListEvents: (c) => this.listEvents(c),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: (request) =>
        jsonRes(
          404,
          errorBody(
            404,
            "not_found",
            `Route ${new URL(request.url).pathname} not found`,
            this.requestId(request),
          ),
        ),
      onError: (thrown, request) => {
        if (thrown instanceof PaddleError) return thrown.toResponse(this.requestId(request))
        throw thrown
      },
      before: (context) => {
        const header = context.request.headers.get("authorization")
        if (!header) {
          return new PaddleError(
            403,
            "authentication_missing",
            "Authentication header missing. Send `Authorization: Bearer <api key>`.",
          ).toResponse(this.requestId(context.request))
        }
        if (!/^bearer\s+\S+$/i.test(header.trim())) {
          return new PaddleError(
            403,
            "authentication_malformed",
            "Authentication header malformed. Send `Authorization: Bearer <api key>`.",
          ).toResponse(this.requestId(context.request))
        }
        return undefined
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
    if (this.fixtures && this.state.customers.count() === 0) this.seedFixtures()
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  /** Empty the namespace; with `fixtures`, the fixture account is seeded again. */
  async reset(): Promise<void> {
    await this.service.reset()
    if (this.fixtures) this.seedFixtures()
  }

  /** Every event the account produced, oldest first. */
  events(): EventRecord[] {
    return this.state.events.list({ order: "oldest" }).map((row) => row.value)
  }

  // ---------------------------------------------------------------------------------------
  // Plumbing

  private requestId(request: Request): string {
    const existing = this.requestIds.get(request)
    if (existing) return existing
    this.requestCounter += 1
    const id = hexUuid(opaqueToken(`paddle-request:${this.requestCounter}`, 32))
    this.requestIds.set(request, id)
    return id
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now() + offsetMs).toISOString()
  }

  private prefix(): string {
    return this.publicNamespace && this.publicNamespace !== "default"
      ? `/ns/${encodeURIComponent(this.publicNamespace)}`
      : ""
  }

  private emit(type: string, data: Json): EventRecord {
    const event: EventRecord = {
      event_id: this.state.nextId("event"),
      event_type: type,
      occurred_at: this.iso(),
      notification_id: null,
      data,
    }
    this.state.events.insert(event.event_id, event)
    if (!this.seeding) this.onEvent?.(event)
    return event
  }

  /** The JSON body, validated against the contract; an absent body is `{}` when allowed. */
  private body(context: OperationContext): Json {
    if (context.body.kind === "invalid") {
      throw new PaddleError(400, "invalid_json", "Request body is not valid JSON")
    }
    const required = context.operation.operation.requestBody
      ? ((context.operation.operation.requestBody as { required?: boolean }).required ?? false)
      : false
    if (context.body.kind === "empty") {
      if (required) throw badRequest("Request body is required")
      return {}
    }
    const issues = bodyIssues(context)
    if (issues.length > 0) {
      throw invalidField(
        issues.map((issue) => {
          const missing = /^missing required property (.+)$/.exec(issue.message)
          const field = missing
            ? [issue.path, missing[1]].filter(Boolean).join(".")
            : issue.path || "body"
          return {
            field,
            message: missing ? `${field}: required field` : `${field}: ${issue.message}`,
          }
        }),
      )
    }
    if (context.body.kind !== "json" || !isRecord(context.body.value)) {
      throw invalidField([{ field: "body", message: "body: must be a JSON object" }])
    }
    return context.body.value
  }

  private includes(context: OperationContext, allowed: string[]): Set<string> {
    const values = listParam(context.query.include) ?? []
    const unknown = values.find((v) => !allowed.includes(v))
    if (unknown !== undefined) {
      throw invalidField([
        { field: "include", message: `include: ${unknown} is not a valid include` },
      ])
    }
    return new Set(values)
  }

  private statusFilter(context: OperationContext): Set<Status> | undefined {
    const values = listParam(context.query.status)
    if (values === undefined) return undefined
    const unknown = values.find((v) => v !== "active" && v !== "archived")
    if (unknown !== undefined) {
      throw invalidField([{ field: "status", message: `status: ${unknown} is not a valid status` }])
    }
    return new Set(values as Status[])
  }

  private page<T extends { id: string }>(
    context: OperationContext,
    rows: T[],
    perPage = DEFAULT_PER_PAGE,
    maxPerPage = MAX_PER_PAGE,
  ): Response {
    const page = paginate(context, this.prefix(), rows, {
      defaultPerPage: perPage,
      maxPerPage,
    })
    return envelope(200, page.data, this.requestId(context.request), page.pagination)
  }

  private ok(
    context: OperationContext,
    status: number,
    data: unknown,
    ids: Record<string, string>,
  ) {
    return annotateResponse(envelope(status, data, this.requestId(context.request)), { ids })
  }

  private mustCustomer(id: string): CustomerRecord {
    const customer = this.state.customers.get(id)
    if (!customer) throw notFound(id)
    return customer
  }

  // ---------------------------------------------------------------------------------------
  // Customers

  createCustomer(input: {
    email: string
    name?: string | null
    custom_data?: CustomData
    locale?: string
  }): CustomerRecord {
    const email = input.email.trim()
    const clash = this.state.customers.list({
      where: (c) => c.email.toLowerCase() === email.toLowerCase(),
    })[0]
    if (clash) {
      throw new PaddleError(
        409,
        "customer_already_exists",
        `Customer with email ${email} already exists (${clash.id})`,
      )
    }
    const at = this.iso()
    const customer: CustomerRecord = {
      id: this.state.nextId("customer"),
      name: input.name ?? null,
      email,
      marketing_consent: false,
      status: "active",
      custom_data: input.custom_data ?? null,
      locale: input.locale ?? "en",
      created_at: at,
      updated_at: at,
      import_meta: null,
    }
    this.state.customers.insert(customer.id, customer)
    this.emit("customer.created", customer)
    return customer
  }

  private listCustomers(context: OperationContext): Response {
    const ids = listParam(context.query.id)
    const emails = listParam(context.query.email)?.map((e) => e.toLowerCase())
    const search = str(context.query.search)?.toLowerCase()
    const statuses = this.statusFilter(context)
    const rows = this.state.customers
      .list({
        where: (c) =>
          (ids === undefined || ids.includes(c.id)) &&
          (emails === undefined || emails.includes(c.email.toLowerCase())) &&
          (statuses === undefined || statuses.has(c.status)) &&
          (search === undefined ||
            c.id.toLowerCase().includes(search) ||
            c.email.toLowerCase().includes(search) ||
            (c.name ?? "").toLowerCase().includes(search)),
      })
      .map((row) => row.value)
    return this.page(context, rows)
  }

  private createCustomerOp(context: OperationContext): Response {
    const body = this.body(context)
    const customer = this.createCustomer({
      email: String(body.email),
      name: nullableStr(body.name, null),
      custom_data: customData(body.custom_data, null),
      ...(typeof body.locale === "string" ? { locale: body.locale } : {}),
    })
    return this.ok(context, 201, customer, { customerId: customer.id })
  }

  private getCustomer(context: OperationContext): Response {
    const customer = this.mustCustomer(context.params.customer_id ?? "")
    return this.ok(context, 200, customer, { customerId: customer.id })
  }

  private updateCustomer(context: OperationContext): Response {
    const customer = this.mustCustomer(context.params.customer_id ?? "")
    const body = this.body(context)
    if (
      typeof body.email === "string" &&
      body.email.toLowerCase() !== customer.email.toLowerCase()
    ) {
      const clash = this.state.customers.list({
        where: (c) => c.email.toLowerCase() === String(body.email).toLowerCase(),
      })[0]
      if (clash) {
        throw new PaddleError(
          409,
          "customer_already_exists",
          `Customer with email ${body.email} already exists (${clash.id})`,
        )
      }
    }
    const updated: CustomerRecord = {
      ...customer,
      email: typeof body.email === "string" ? body.email.trim() : customer.email,
      name: nullableStr(body.name, customer.name),
      status: (str(body.status) as Status | undefined) ?? customer.status,
      custom_data: customData(body.custom_data, customer.custom_data),
      locale: str(body.locale) ?? customer.locale,
      updated_at: this.iso(),
    }
    this.state.customers.update(customer.id, updated)
    this.emit("customer.updated", updated)
    return this.ok(context, 200, updated, { customerId: customer.id })
  }

  private creditBalances(context: OperationContext): Response {
    const customer = this.mustCustomer(context.params.customer_id ?? "")
    return this.ok(context, 200, [], { customerId: customer.id })
  }

  private authToken(context: OperationContext): Response {
    const customer = this.mustCustomer(context.params.customer_id ?? "")
    return this.ok(
      context,
      200,
      {
        customer_auth_token: this.state.nextToken("pca_", 48),
        expires_at: this.iso(AUTH_TOKEN_TTL_MS),
      },
      { customerId: customer.id },
    )
  }

  // ---------------------------------------------------------------------------------------
  // Addresses and businesses

  createAddress(
    customerId: string,
    input: Partial<
      Omit<
        AddressRecord,
        "id" | "customer_id" | "status" | "created_at" | "updated_at" | "import_meta"
      >
    > & {
      country_code: string
    },
  ): AddressRecord {
    this.mustCustomer(customerId)
    const at = this.iso()
    const address: AddressRecord = {
      id: this.state.nextId("address"),
      customer_id: customerId,
      description: input.description ?? null,
      first_line: input.first_line ?? null,
      second_line: input.second_line ?? null,
      city: input.city ?? null,
      postal_code: input.postal_code ?? null,
      region: input.region ?? null,
      country_code: input.country_code,
      custom_data: input.custom_data ?? null,
      status: "active",
      created_at: at,
      updated_at: at,
      import_meta: null,
    }
    this.state.addresses.insert(address.id, address)
    this.emit("address.created", address)
    return address
  }

  private mustAddress(customerId: string, id: string): AddressRecord {
    const address = this.state.addresses.get(id)
    if (!address || address.customer_id !== customerId) throw notFound(id)
    return address
  }

  private listAddresses(context: OperationContext): Response {
    const customer = this.mustCustomer(context.params.customer_id ?? "")
    const ids = listParam(context.query.id)
    const search = str(context.query.search)?.toLowerCase()
    const statuses = this.statusFilter(context)
    const rows = this.state.addresses
      .list({
        where: (a) =>
          a.customer_id === customer.id &&
          (ids === undefined || ids.includes(a.id)) &&
          (statuses === undefined || statuses.has(a.status)) &&
          (search === undefined ||
            [a.id, a.description, a.first_line, a.city, a.postal_code, a.country_code].some((v) =>
              (v ?? "").toLowerCase().includes(search),
            )),
      })
      .map((row) => row.value)
    return this.page(context, rows)
  }

  private createAddressOp(context: OperationContext): Response {
    const customer = this.mustCustomer(context.params.customer_id ?? "")
    const body = this.body(context)
    const address = this.createAddress(customer.id, {
      country_code: String(body.country_code),
      description: nullableStr(body.description, null),
      first_line: nullableStr(body.first_line, null),
      second_line: nullableStr(body.second_line, null),
      city: nullableStr(body.city, null),
      postal_code: nullableStr(body.postal_code, null),
      region: nullableStr(body.region, null),
      custom_data: customData(body.custom_data, null),
    })
    return this.ok(context, 201, address, { customerId: customer.id, addressId: address.id })
  }

  private getAddress(context: OperationContext): Response {
    const customer = this.mustCustomer(context.params.customer_id ?? "")
    const address = this.mustAddress(customer.id, context.params.address_id ?? "")
    return this.ok(context, 200, address, { customerId: customer.id, addressId: address.id })
  }

  private updateAddress(context: OperationContext): Response {
    const customer = this.mustCustomer(context.params.customer_id ?? "")
    const address = this.mustAddress(customer.id, context.params.address_id ?? "")
    const body = this.body(context)
    const updated: AddressRecord = {
      ...address,
      description: nullableStr(body.description, address.description),
      first_line: nullableStr(body.first_line, address.first_line),
      second_line: nullableStr(body.second_line, address.second_line),
      city: nullableStr(body.city, address.city),
      postal_code: nullableStr(body.postal_code, address.postal_code),
      region: nullableStr(body.region, address.region),
      country_code: str(body.country_code) ?? address.country_code,
      custom_data: customData(body.custom_data, address.custom_data),
      status: (str(body.status) as Status | undefined) ?? address.status,
      updated_at: this.iso(),
    }
    this.state.addresses.update(address.id, updated)
    this.emit("address.updated", updated)
    return this.ok(context, 200, updated, { customerId: customer.id, addressId: address.id })
  }

  createBusiness(
    customerId: string,
    input: {
      name: string
      company_number?: string | null
      tax_identifier?: string | null
      contacts?: { name?: string | null; email: string }[] | null
      custom_data?: CustomData
    },
  ): BusinessRecord {
    this.mustCustomer(customerId)
    const at = this.iso()
    const business: BusinessRecord = {
      id: this.state.nextId("business"),
      customer_id: customerId,
      name: input.name,
      company_number: input.company_number ?? null,
      tax_identifier: input.tax_identifier ?? null,
      status: "active",
      contacts: input.contacts
        ? input.contacts.map((c) => ({ name: c.name ?? null, email: c.email }))
        : null,
      created_at: at,
      updated_at: at,
      custom_data: input.custom_data ?? null,
      import_meta: null,
    }
    this.state.businesses.insert(business.id, business)
    this.emit("business.created", business)
    return business
  }

  private mustBusiness(customerId: string, id: string): BusinessRecord {
    const business = this.state.businesses.get(id)
    if (!business || business.customer_id !== customerId) throw notFound(id)
    return business
  }

  private listBusinesses(context: OperationContext): Response {
    const customer = this.mustCustomer(context.params.customer_id ?? "")
    const ids = listParam(context.query.id)
    const search = str(context.query.search)?.toLowerCase()
    const statuses = this.statusFilter(context)
    const rows = this.state.businesses
      .list({
        where: (b) =>
          b.customer_id === customer.id &&
          (ids === undefined || ids.includes(b.id)) &&
          (statuses === undefined || statuses.has(b.status)) &&
          (search === undefined ||
            [b.id, b.name, b.company_number, b.tax_identifier].some((v) =>
              (v ?? "").toLowerCase().includes(search),
            )),
      })
      .map((row) => row.value)
    return this.page(context, rows)
  }

  private contacts(value: unknown): { name?: string | null; email: string }[] | null | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value)) return null
    return value
      .filter(isRecord)
      .map((c) => ({ name: nullableStr(c.name, null), email: String(c.email) }))
  }

  private createBusinessOp(context: OperationContext): Response {
    const customer = this.mustCustomer(context.params.customer_id ?? "")
    const body = this.body(context)
    const business = this.createBusiness(customer.id, {
      name: String(body.name),
      company_number: nullableStr(body.company_number, null),
      tax_identifier: nullableStr(body.tax_identifier, null),
      contacts: this.contacts(body.contacts) ?? null,
      custom_data: customData(body.custom_data, null),
    })
    return this.ok(context, 201, business, { customerId: customer.id, businessId: business.id })
  }

  private getBusiness(context: OperationContext): Response {
    const customer = this.mustCustomer(context.params.customer_id ?? "")
    const business = this.mustBusiness(customer.id, context.params.business_id ?? "")
    return this.ok(context, 200, business, { customerId: customer.id, businessId: business.id })
  }

  private updateBusiness(context: OperationContext): Response {
    const customer = this.mustCustomer(context.params.customer_id ?? "")
    const business = this.mustBusiness(customer.id, context.params.business_id ?? "")
    const body = this.body(context)
    const contacts = this.contacts(body.contacts)
    const updated: BusinessRecord = {
      ...business,
      name: str(body.name) ?? business.name,
      company_number: nullableStr(body.company_number, business.company_number),
      tax_identifier: nullableStr(body.tax_identifier, business.tax_identifier),
      status: (str(body.status) as Status | undefined) ?? business.status,
      contacts:
        contacts === undefined
          ? business.contacts
          : contacts === null
            ? null
            : contacts.map((c) => ({ name: c.name ?? null, email: c.email })),
      custom_data: customData(body.custom_data, business.custom_data),
      updated_at: this.iso(),
    }
    this.state.businesses.update(business.id, updated)
    this.emit("business.updated", updated)
    return this.ok(context, 200, updated, { customerId: customer.id, businessId: business.id })
  }

  // ---------------------------------------------------------------------------------------
  // Catalog

  /** The product record for an input, not yet stored (`commitProduct` stores and announces it). */
  private buildProduct(input: {
    name: string
    tax_category: string
    type?: "standard" | "custom" | null
    description?: string | null
    image_url?: string | null
    custom_data?: CustomData
  }): ProductRecord {
    const at = this.iso()
    return {
      id: this.state.nextId("product"),
      name: input.name,
      type: input.type ?? "standard",
      description: input.description ?? null,
      tax_category: input.tax_category,
      image_url: input.image_url ?? null,
      custom_data: input.custom_data ?? null,
      status: "active",
      created_at: at,
      updated_at: at,
      import_meta: null,
    }
  }

  private commitProduct(product: ProductRecord): ProductRecord {
    this.state.products.insert(product.id, product)
    this.emit("product.created", product)
    return product
  }

  createProduct(input: Parameters<PaddleAPI["buildProduct"]>[0]): ProductRecord {
    return this.commitProduct(this.buildProduct(input))
  }

  private mustProduct(id: string): ProductRecord {
    const product = this.state.products.get(id)
    if (!product) throw notFound(id)
    return product
  }

  private renderProduct(product: ProductRecord, include: Set<string>) {
    if (!include.has("prices")) return product
    return {
      ...product,
      prices: this.state.prices
        .list({ where: (p) => p.product_id === product.id })
        .map((row) => row.value),
    }
  }

  private listProducts(context: OperationContext): Response {
    const ids = listParam(context.query.id)
    const statuses = this.statusFilter(context)
    const taxCategories = listParam(context.query.tax_category)
    const types = listParam(context.query.type)
    const include = this.includes(context, ["prices"])
    const rows = this.state.products
      .list({
        where: (p) =>
          (ids === undefined || ids.includes(p.id)) &&
          (statuses === undefined || statuses.has(p.status)) &&
          (taxCategories === undefined || taxCategories.includes(p.tax_category)) &&
          (types === undefined || types.includes(p.type)),
      })
      .map((row) => row.value)
    const page = paginate(context, this.prefix(), rows, {
      defaultPerPage: DEFAULT_PER_PAGE,
      maxPerPage: MAX_PER_PAGE,
    })
    return envelope(
      200,
      page.data.map((p) => this.renderProduct(p, include)),
      this.requestId(context.request),
      page.pagination,
    )
  }

  private createProductOp(context: OperationContext): Response {
    const body = this.body(context)
    const product = this.createProduct({
      name: String(body.name),
      tax_category: String(body.tax_category),
      type: (nullableStr(body.type, null) as "standard" | "custom" | null) ?? "standard",
      description: nullableStr(body.description, null),
      image_url: nullableStr(body.image_url, null),
      custom_data: customData(body.custom_data, null),
    })
    return this.ok(context, 201, product, { productId: product.id })
  }

  private getProduct(context: OperationContext): Response {
    const include = this.includes(context, ["prices"])
    const product = this.mustProduct(context.params.product_id ?? "")
    return this.ok(context, 200, this.renderProduct(product, include), { productId: product.id })
  }

  private updateProduct(context: OperationContext): Response {
    const product = this.mustProduct(context.params.product_id ?? "")
    const body = this.body(context)
    const updated: ProductRecord = {
      ...product,
      name: str(body.name) ?? product.name,
      tax_category: str(body.tax_category) ?? product.tax_category,
      type:
        body.type === undefined
          ? product.type
          : ((str(body.type) as "standard" | "custom" | undefined) ?? "standard"),
      description: nullableStr(body.description, product.description),
      image_url: nullableStr(body.image_url, product.image_url),
      custom_data: customData(body.custom_data, product.custom_data),
      status: (str(body.status) as Status | undefined) ?? product.status,
      updated_at: this.iso(),
    }
    this.state.products.update(product.id, updated)
    this.emit("product.updated", updated)
    return this.ok(context, 200, updated, { productId: product.id })
  }

  private timePeriod(value: unknown, field: string, errors: FieldError[]): TimePeriod | null {
    if (value === null || value === undefined) return null
    if (
      !isRecord(value) ||
      typeof value.interval !== "string" ||
      typeof value.frequency !== "number"
    ) {
      errors.push({ field, message: `${field}: must have interval and frequency` })
      return null
    }
    return { interval: value.interval as TimePeriod["interval"], frequency: value.frequency }
  }

  /**
   * The validated price record for an input, not yet stored (`commitPrice` stores and announces
   * it). `product` is a product that is itself not stored yet (a non-catalog item's product).
   */
  private buildPrice(
    input: {
      product_id: string
      description: string
      unit_price: { amount: string; currency_code: string }
      name?: string | null
      type?: "standard" | "custom" | null
      billing_cycle?: TimePeriod | null
      trial_period?: TrialPeriod | null
      tax_mode?: string
      unit_price_overrides?: {
        country_codes: string[]
        unit_price: { amount: string; currency_code: string }
      }[]
      quantity?: { minimum: number; maximum: number }
      custom_data?: CustomData
    },
    product?: ProductRecord,
  ): PriceRecord {
    const errors: FieldError[] = []
    if (product?.id !== input.product_id && !this.state.products.has(input.product_id)) {
      errors.push({
        field: "product_id",
        message: `product_id: product ${input.product_id} not found`,
      })
    }
    if (!CURRENCIES.includes(input.unit_price.currency_code)) {
      errors.push({
        field: "unit_price.currency_code",
        message: "unit_price.currency_code: unsupported currency",
      })
    }
    const quantity = input.quantity ?? { minimum: 1, maximum: 100 }
    if (quantity.minimum > quantity.maximum) {
      errors.push({ field: "quantity", message: "quantity: minimum must not exceed maximum" })
    }
    if (input.trial_period && !input.billing_cycle) {
      errors.push({
        field: "trial_period",
        message: "trial_period: only recurring prices can have a trial",
      })
    }
    if (errors.length > 0) throw invalidField(errors)
    const at = this.iso()
    const price: PriceRecord = {
      id: this.state.nextId("price"),
      product_id: input.product_id,
      description: input.description,
      type: input.type ?? "standard",
      name: input.name ?? null,
      billing_cycle: input.billing_cycle ?? null,
      trial_period: input.trial_period ?? null,
      tax_mode: input.tax_mode ?? "account_setting",
      unit_price: {
        amount: input.unit_price.amount,
        currency_code: input.unit_price.currency_code,
      },
      unit_price_overrides: (input.unit_price_overrides ?? []).map((o) => ({
        country_codes: [...o.country_codes],
        unit_price: { amount: o.unit_price.amount, currency_code: o.unit_price.currency_code },
      })),
      quantity,
      status: "active",
      created_at: at,
      updated_at: at,
      custom_data: input.custom_data ?? null,
      import_meta: null,
    }
    return price
  }

  private commitPrice(price: PriceRecord): PriceRecord {
    this.state.prices.insert(price.id, price)
    this.emit("price.created", price)
    return price
  }

  createPrice(input: Parameters<PaddleAPI["buildPrice"]>[0]): PriceRecord {
    return this.commitPrice(this.buildPrice(input))
  }

  private mustPrice(id: string): PriceRecord {
    const price = this.state.prices.get(id)
    if (!price) throw notFound(id)
    return price
  }

  private renderPrice(price: PriceRecord, include: Set<string>) {
    if (!include.has("product")) return price
    return { ...price, product: this.state.products.get(price.product_id) ?? null }
  }

  private listPrices(context: OperationContext): Response {
    const ids = listParam(context.query.id)
    const productIds = listParam(context.query.product_id)
    const statuses = this.statusFilter(context)
    const types = listParam(context.query.type)
    const recurring = str(context.query.recurring)
    const include = this.includes(context, ["product"])
    const rows = this.state.prices
      .list({
        where: (p) =>
          (ids === undefined || ids.includes(p.id)) &&
          (productIds === undefined || productIds.includes(p.product_id)) &&
          (statuses === undefined || statuses.has(p.status)) &&
          (types === undefined || types.includes(p.type)) &&
          (recurring === undefined || (p.billing_cycle !== null) === (recurring === "true")),
      })
      .map((row) => row.value)
    const page = paginate(context, this.prefix(), rows, {
      defaultPerPage: DEFAULT_PER_PAGE,
      maxPerPage: MAX_PER_PAGE,
    })
    return envelope(
      200,
      page.data.map((p) => this.renderPrice(p, include)),
      this.requestId(context.request),
      page.pagination,
    )
  }

  private priceInput(body: Json, errors: FieldError[]) {
    const unitPrice = isRecord(body.unit_price) ? body.unit_price : {}
    const overrides = Array.isArray(body.unit_price_overrides)
      ? body.unit_price_overrides.filter(isRecord).map((o) => ({
          country_codes: Array.isArray(o.country_codes) ? o.country_codes.map(String) : [],
          unit_price: isRecord(o.unit_price)
            ? {
                amount: String(o.unit_price.amount),
                currency_code: String(o.unit_price.currency_code),
              }
            : { amount: "0", currency_code: "USD" },
        }))
      : undefined
    const quantity = isRecord(body.quantity)
      ? { minimum: Number(body.quantity.minimum), maximum: Number(body.quantity.maximum) }
      : undefined
    const trial = this.timePeriod(body.trial_period, "trial_period", errors)
    return {
      description: str(body.description),
      name: nullableStr(body.name, null),
      type: (nullableStr(body.type, null) as "standard" | "custom" | null) ?? "standard",
      billing_cycle: this.timePeriod(body.billing_cycle, "billing_cycle", errors),
      trial_period:
        trial === null
          ? null
          : {
              ...trial,
              ...(isRecord(body.trial_period) &&
              typeof body.trial_period.requires_payment_method === "boolean"
                ? { requires_payment_method: body.trial_period.requires_payment_method }
                : {}),
            },
      tax_mode: str(body.tax_mode),
      unit_price:
        body.unit_price === undefined
          ? undefined
          : { amount: String(unitPrice.amount), currency_code: String(unitPrice.currency_code) },
      unit_price_overrides: overrides,
      quantity,
      custom_data: customData(body.custom_data, null),
      hasCustomData: body.custom_data !== undefined,
    }
  }

  private createPriceOp(context: OperationContext): Response {
    const body = this.body(context)
    const errors: FieldError[] = []
    const input = this.priceInput(body, errors)
    if (errors.length > 0) throw invalidField(errors)
    const price = this.createPrice({
      product_id: String(body.product_id),
      description: input.description ?? "",
      unit_price: input.unit_price ?? { amount: "0", currency_code: "USD" },
      name: input.name,
      type: input.type,
      billing_cycle: input.billing_cycle,
      trial_period: input.trial_period,
      ...(input.tax_mode !== undefined ? { tax_mode: input.tax_mode } : {}),
      ...(input.unit_price_overrides !== undefined
        ? { unit_price_overrides: input.unit_price_overrides }
        : {}),
      ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
      custom_data: input.custom_data,
    })
    return this.ok(context, 201, price, { priceId: price.id, productId: price.product_id })
  }

  private getPrice(context: OperationContext): Response {
    const include = this.includes(context, ["product"])
    const price = this.mustPrice(context.params.price_id ?? "")
    return this.ok(context, 200, this.renderPrice(price, include), { priceId: price.id })
  }

  private updatePrice(context: OperationContext): Response {
    const price = this.mustPrice(context.params.price_id ?? "")
    const body = this.body(context)
    const errors: FieldError[] = []
    const input = this.priceInput(body, errors)
    const quantity = input.quantity ?? price.quantity
    if (quantity.minimum > quantity.maximum) {
      errors.push({ field: "quantity", message: "quantity: minimum must not exceed maximum" })
    }
    if (input.unit_price && !CURRENCIES.includes(input.unit_price.currency_code)) {
      errors.push({
        field: "unit_price.currency_code",
        message: "unit_price.currency_code: unsupported currency",
      })
    }
    if (errors.length > 0) throw invalidField(errors)
    const updated: PriceRecord = {
      ...price,
      description: input.description ?? price.description,
      name: body.name === undefined ? price.name : input.name,
      type: body.type === undefined ? price.type : input.type,
      billing_cycle: body.billing_cycle === undefined ? price.billing_cycle : input.billing_cycle,
      trial_period: body.trial_period === undefined ? price.trial_period : input.trial_period,
      tax_mode: input.tax_mode ?? price.tax_mode,
      unit_price: input.unit_price ?? price.unit_price,
      unit_price_overrides: input.unit_price_overrides ?? price.unit_price_overrides,
      quantity,
      status: (str(body.status) as Status | undefined) ?? price.status,
      custom_data: input.hasCustomData ? input.custom_data : price.custom_data,
      updated_at: this.iso(),
    }
    this.state.prices.update(price.id, updated)
    this.emit("price.updated", updated)
    return this.ok(context, 200, updated, { priceId: price.id })
  }

  // ---------------------------------------------------------------------------------------
  // Transactions

  /**
   * The priced items of a request: catalog prices by `price_id`, or non-catalog `price`
   * objects, whose `type: custom` price (and product) are only stored once the whole request
   * has validated: the caller runs `catalog` after its last check (a preview never does).
   */
  private resolveItems(
    raw: unknown,
    field: string,
    errors: FieldError[],
    catalog: (() => void)[],
  ): Priced[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      errors.push({ field, message: `${field}: at least one item is required` })
      return []
    }
    const out: Priced[] = []
    raw.forEach((item, index) => {
      const at = `${field}[${index}]`
      if (!isRecord(item)) {
        errors.push({ field: at, message: `${at}: must be an object` })
        return
      }
      const quantity = typeof item.quantity === "number" ? item.quantity : 1
      let price: PriceRecord | undefined
      let product: ProductRecord | undefined
      if (typeof item.price_id === "string") {
        price = this.state.prices.get(item.price_id)
        if (!price)
          errors.push({
            field: `${at}.price_id`,
            message: `${at}.price_id: price ${item.price_id} not found`,
          })
        else if (price.status === "archived") {
          errors.push({
            field: `${at}.price_id`,
            message: `${at}.price_id: price ${item.price_id} is archived`,
          })
        }
        product = price ? this.state.products.get(price.product_id) : undefined
      } else if (isRecord(item.price)) {
        const spec = item.price
        const productId = str(spec.product_id)
        if (productId !== undefined) {
          product = this.state.products.get(productId)
          if (!product) {
            errors.push({
              field: `${at}.price.product_id`,
              message: `${at}.price.product_id: product ${productId} not found`,
            })
            return
          }
        } else if (isRecord(spec.product)) {
          const built = this.buildProduct({
            name: String(spec.product.name),
            tax_category: String(spec.product.tax_category),
            type: "custom",
            description: nullableStr(spec.product.description, null),
            image_url: nullableStr(spec.product.image_url, null),
            custom_data: customData(spec.product.custom_data, null),
          })
          product = built
          catalog.push(() => this.commitProduct(built))
        } else {
          errors.push({
            field: `${at}.price`,
            message: `${at}.price: product_id or product is required`,
          })
          return
        }
        const inner: FieldError[] = []
        const input = this.priceInput(spec, inner)
        try {
          const built = this.buildPrice(
            {
              product_id: product.id,
              description: input.description ?? "",
              unit_price: input.unit_price ?? { amount: "0", currency_code: "USD" },
              name: input.name,
              type: "custom",
              billing_cycle: input.billing_cycle,
              trial_period: input.trial_period,
              ...(input.tax_mode !== undefined ? { tax_mode: input.tax_mode } : {}),
              ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
              custom_data: input.custom_data,
            },
            product,
          )
          price = built
          catalog.push(() => this.commitPrice(built))
        } catch (error) {
          if (error instanceof PaddleError && error.errors) {
            for (const e of error.errors)
              errors.push({ field: `${at}.price.${e.field}`, message: e.message })
          } else throw error
        }
        for (const e of inner) errors.push({ field: `${at}.price.${e.field}`, message: e.message })
      } else {
        errors.push({ field: at, message: `${at}: price_id or price is required` })
      }
      if (!price || !product) return
      if (quantity < price.quantity.minimum || quantity > price.quantity.maximum) {
        errors.push({
          field: `${at}.quantity`,
          message: `${at}.quantity: must be between ${price.quantity.minimum} and ${price.quantity.maximum}`,
        })
      }
      out.push({
        price,
        product,
        quantity,
        ...(item.include_in_totals === false ? { counted: false } : {}),
      })
    })
    return out
  }

  private resolveParties(
    body: { customer_id?: unknown; address_id?: unknown; business_id?: unknown },
    errors: FieldError[],
  ): { customer_id: string | null; address_id: string | null; business_id: string | null } {
    const customerId = nullableStr(body.customer_id, null)
    const addressId = nullableStr(body.address_id, null)
    const businessId = nullableStr(body.business_id, null)
    if (customerId !== null && !this.state.customers.has(customerId)) {
      errors.push({
        field: "customer_id",
        message: `customer_id: customer ${customerId} not found`,
      })
    }
    if (addressId !== null) {
      const address = this.state.addresses.get(addressId)
      if (customerId === null)
        errors.push({ field: "address_id", message: "address_id: requires customer_id" })
      else if (!address || address.customer_id !== customerId) {
        errors.push({
          field: "address_id",
          message: `address_id: address ${addressId} not found for customer`,
        })
      }
    }
    if (businessId !== null) {
      const business = this.state.businesses.get(businessId)
      if (customerId === null)
        errors.push({ field: "business_id", message: "business_id: requires customer_id" })
      else if (!business || business.customer_id !== customerId) {
        errors.push({
          field: "business_id",
          message: `business_id: business ${businessId} not found for customer`,
        })
      }
    }
    return { customer_id: customerId, address_id: addressId, business_id: businessId }
  }

  private billingDetails(value: unknown, errors: FieldError[]): BillingDetails | null {
    if (value === null || value === undefined) return null
    if (!isRecord(value)) {
      errors.push({ field: "billing_details", message: "billing_details: must be an object" })
      return null
    }
    const terms = this.timePeriod(value.payment_terms, "billing_details.payment_terms", errors)
    return {
      enable_checkout: value.enable_checkout === true,
      purchase_order_number: nullableStr(value.purchase_order_number, null),
      additional_information: nullableStr(value.additional_information, null),
      payment_terms: terms ?? { interval: "day", frequency: 30 },
    }
  }

  private period(value: unknown, field: string, errors: FieldError[]): Period | null {
    if (value === null || value === undefined) return null
    if (
      !isRecord(value) ||
      typeof value.starts_at !== "string" ||
      typeof value.ends_at !== "string"
    ) {
      errors.push({ field, message: `${field}: must have starts_at and ends_at` })
      return null
    }
    return { starts_at: value.starts_at, ends_at: value.ends_at }
  }

  private countryOf(addressId: string | null): string | null {
    return addressId ? (this.state.addresses.get(addressId)?.country_code ?? null) : null
  }

  private lineItems(items: Priced[], countryCode: string | null): LineItem[] {
    return items.map((item) => ({
      id: this.state.nextId("line_item"),
      ...previewLineItem(item, countryCode),
    }))
  }

  private checkoutFor(id: string, collectionMode: CollectionMode, details: BillingDetails | null) {
    const wanted = collectionMode === "automatic" || details?.enable_checkout === true
    return { url: wanted && this.paymentLink ? `${this.paymentLink}?_ptxn=${id}` : null }
  }

  /** Build (or rebuild) a transaction from request fields; shared by create and update. */
  private transactionFrom(
    input: TransactionInput,
    base: TransactionRecord | undefined,
    origin: TransactionOrigin,
  ): TransactionRecord {
    const errors: FieldError[] = []
    const catalog: (() => void)[] = []
    const items =
      input.items === undefined && base
        ? base.items.map((i) => ({
            price: i.price,
            product: this.state.products.get(i.price.product_id) as ProductRecord,
            quantity: i.quantity,
          }))
        : this.resolveItems(input.items, "items", errors, catalog)
    const parties =
      input.customer_id === undefined &&
      input.address_id === undefined &&
      input.business_id === undefined &&
      base
        ? {
            customer_id: base.customer_id,
            address_id: base.address_id,
            business_id: base.business_id,
          }
        : this.resolveParties(
            {
              customer_id: input.customer_id ?? base?.customer_id ?? null,
              address_id: input.address_id ?? base?.address_id ?? null,
              business_id: input.business_id ?? base?.business_id ?? null,
            },
            errors,
          )
    const currency =
      str(input.currency_code) ??
      base?.currency_code ??
      items[0]?.price.unit_price.currency_code ??
      "USD"
    if (!CURRENCIES.includes(currency)) {
      errors.push({ field: "currency_code", message: "currency_code: unsupported currency" })
    }
    items.forEach((item, index) => {
      if (item.price.unit_price.currency_code !== currency) {
        errors.push({
          field: `items[${index}].price_id`,
          message: `items[${index}].price_id: price is in ${item.price.unit_price.currency_code}, transaction is in ${currency}`,
        })
      }
    })
    const recurring = items.filter((i) => i.price.billing_cycle !== null)
    const cycle = recurring[0]?.price.billing_cycle ?? null
    if (recurring.some((i) => !samePeriod(i.price.billing_cycle, cycle))) {
      errors.push({
        field: "items",
        message: "items: recurring items must share one billing cycle",
      })
    }
    const collectionMode =
      (str(input.collection_mode) as CollectionMode | undefined) ??
      base?.collection_mode ??
      "automatic"
    const billingDetails =
      input.billing_details === undefined
        ? (base?.billing_details ?? null)
        : this.billingDetails(input.billing_details, errors)
    if (collectionMode === "manual" && !billingDetails) {
      errors.push({
        field: "billing_details",
        message: "billing_details: required when collection_mode is manual",
      })
    }
    const billingPeriod =
      input.billing_period === undefined
        ? (base?.billing_period ?? null)
        : this.period(input.billing_period, "billing_period", errors)
    const hasParties = parties.customer_id !== null && parties.address_id !== null
    let status: TransactionStatus =
      (str(input.status) as TransactionStatus | undefined) ??
      base?.status ??
      (hasParties ? "ready" : "draft")
    if (input.status === undefined && base && base.status === "draft" && hasParties)
      status = "ready"
    if (status === "ready" && !hasParties) {
      errors.push({ field: "status", message: "status: ready requires customer_id and address_id" })
    }
    if (status === "billed" && (collectionMode !== "manual" || !hasParties)) {
      errors.push({
        field: "status",
        message: "status: billed requires collection_mode manual, customer_id and address_id",
      })
    }
    if (errors.length > 0) throw invalidField(errors)
    for (const commit of catalog) commit()
    const at = this.iso()
    const id = base?.id ?? this.state.nextId("transaction")
    const country = this.countryOf(parties.address_id)
    const lines = this.lineItems(items, country)
    const billed = status === "billed" && base?.status !== "billed"
    const checkout =
      input.checkout === undefined
        ? (base?.checkout ?? this.checkoutFor(id, collectionMode, billingDetails))
        : isRecord(input.checkout)
          ? { url: nullableStr(input.checkout.url, null) }
          : null
    return {
      id,
      status,
      customer_id: parties.customer_id,
      address_id: parties.address_id,
      business_id: parties.business_id,
      custom_data: customData(input.custom_data, base?.custom_data ?? null),
      currency_code: currency,
      origin: base?.origin ?? origin,
      subscription_id: base?.subscription_id ?? null,
      invoice_id: base?.invoice_id ?? (billed ? this.state.nextId("invoice") : null),
      invoice_number: base?.invoice_number ?? (billed ? this.nextInvoiceNumber() : null),
      collection_mode: collectionMode,
      discount_id: null,
      billing_details: billingDetails,
      billing_period: billingPeriod,
      items: items.map((item, index) => ({
        price_id: item.price.id,
        price: item.price,
        quantity: item.quantity,
        proration: null,
        ...(lines[index] ? {} : {}),
      })),
      details: transactionDetails(lines, currency),
      payments: base?.payments ?? [],
      checkout,
      created_at: base?.created_at ?? at,
      updated_at: at,
      billed_at: base?.billed_at ?? (billed ? at : null),
      revised_at: null,
    }
  }

  /** Sequential and unique: one more than the invoices issued so far (`MOCK-01001` first). */
  private nextInvoiceNumber(): string {
    const issued = this.state.transactions.list({ where: (t) => t.invoice_number !== null }).length
    return `MOCK-${String(1001 + issued).padStart(5, "0")}`
  }

  private transactionEvents(transaction: TransactionRecord, created: boolean) {
    this.emit(created ? "transaction.created" : "transaction.updated", transaction)
    if (created && transaction.status === "ready") this.emit("transaction.ready", transaction)
    if (transaction.status === "billed") this.emit("transaction.billed", transaction)
    if (transaction.status === "canceled") this.emit("transaction.canceled", transaction)
  }

  /** `POST /transactions` as a method: what the hosted checkout and the admin routes call. */
  createTransaction(input: Json, origin: TransactionOrigin = "api"): TransactionRecord {
    const transaction = this.transactionFrom(input as TransactionInput, undefined, origin)
    this.state.transactions.insert(transaction.id, transaction)
    this.transactionEvents(transaction, true)
    return transaction
  }

  private mustTransaction(id: string): TransactionRecord {
    const transaction = this.state.transactions.get(id)
    if (!transaction) throw notFound(id)
    return transaction
  }

  private renderTransaction(transaction: TransactionRecord, include: Set<string>) {
    return {
      ...transaction,
      ...(include.has("customer")
        ? {
            customer: transaction.customer_id
              ? (this.state.customers.get(transaction.customer_id) ?? null)
              : null,
          }
        : {}),
      ...(include.has("address")
        ? {
            address: transaction.address_id
              ? (this.state.addresses.get(transaction.address_id) ?? null)
              : null,
          }
        : {}),
      ...(include.has("business")
        ? {
            business: transaction.business_id
              ? (this.state.businesses.get(transaction.business_id) ?? null)
              : null,
          }
        : {}),
    }
  }

  private dateFilter(context: OperationContext, field: string, errors: FieldError[]) {
    const raw = context.query[field]
    if (raw === undefined) return () => true
    const bounds: { op: string; at: number }[] = []
    const entries = isRecord(raw) ? Object.entries(raw) : [["EQ", raw] as const]
    for (const [op, value] of entries) {
      const at = typeof value === "string" ? Date.parse(value) : Number.NaN
      if (Number.isNaN(at) || !["EQ", "LT", "LTE", "GT", "GTE"].includes(op)) {
        errors.push({ field, message: `${field}: must be an RFC 3339 datetime` })
        continue
      }
      bounds.push({ op, at })
    }
    return (value: string | null) => {
      if (value === null) return bounds.length === 0
      const t = Date.parse(value)
      return bounds.every(({ op, at }) =>
        op === "LT"
          ? t < at
          : op === "LTE"
            ? t <= at
            : op === "GT"
              ? t > at
              : op === "GTE"
                ? t >= at
                : t === at,
      )
    }
  }

  private listTransactions(context: OperationContext): Response {
    const errors: FieldError[] = []
    const ids = listParam(context.query.id)
    const customerIds = listParam(context.query.customer_id)
    const subscriptionIds = listParam(context.query.subscription_id)
    const statuses = listParam(context.query.status)
    const origins = listParam(context.query.origin)
    const collectionMode = str(context.query.collection_mode)
    const invoiceNumbers = listParam(context.query.invoice_number)
    const include = this.includes(context, TRANSACTION_INCLUDES)
    const createdAt = this.dateFilter(context, "created_at", errors)
    const billedAt = this.dateFilter(context, "billed_at", errors)
    const updatedAt = this.dateFilter(context, "updated_at", errors)
    if (errors.length > 0) throw invalidField(errors)
    const rows = this.state.transactions
      .list({
        where: (t) =>
          (ids === undefined || ids.includes(t.id)) &&
          (customerIds === undefined ||
            (t.customer_id !== null && customerIds.includes(t.customer_id))) &&
          (subscriptionIds === undefined ||
            (t.subscription_id !== null && subscriptionIds.includes(t.subscription_id))) &&
          (statuses === undefined || statuses.includes(t.status)) &&
          (origins === undefined || origins.includes(t.origin)) &&
          (collectionMode === undefined || t.collection_mode === collectionMode) &&
          (invoiceNumbers === undefined ||
            (t.invoice_number !== null && invoiceNumbers.includes(t.invoice_number))) &&
          createdAt(t.created_at) &&
          billedAt(t.billed_at) &&
          updatedAt(t.updated_at),
      })
      .map((row) => row.value)
    const page = paginate(context, this.prefix(), rows, {
      defaultPerPage: TRANSACTIONS_PER_PAGE,
      maxPerPage: TRANSACTIONS_PER_PAGE,
    })
    return envelope(
      200,
      page.data.map((t) => this.renderTransaction(t, include)),
      this.requestId(context.request),
      page.pagination,
    )
  }

  private createTransactionOp(context: OperationContext): Response {
    const include = this.includes(context, TRANSACTION_INCLUDES)
    const body = this.body(context)
    const transaction = this.createTransaction(body, "api")
    return this.ok(context, 201, this.renderTransaction(transaction, include), {
      transactionId: transaction.id,
    })
  }

  private previewTransaction(context: OperationContext): Response {
    const body = this.body(context)
    const errors: FieldError[] = []
    // A preview stores nothing: non-catalog prices are priced but never committed.
    const items = this.resolveItems(body.items, "items", errors, [])
    const parties = this.resolveParties(body, errors)
    const currency =
      nullableStr(body.currency_code, null) ?? items[0]?.price.unit_price.currency_code ?? "USD"
    if (!CURRENCIES.includes(currency)) {
      errors.push({ field: "currency_code", message: "currency_code: unsupported currency" })
    }
    items.forEach((item, index) => {
      if (item.price.unit_price.currency_code !== currency) {
        errors.push({
          field: `items[${index}].price_id`,
          message: `items[${index}].price_id: price is in ${item.price.unit_price.currency_code}, preview is in ${currency}`,
        })
      }
    })
    const address = isRecord(body.address)
      ? {
          postal_code: nullableStr(body.address.postal_code, null),
          country_code: String(body.address.country_code),
        }
      : null
    if (errors.length > 0) throw invalidField(errors)
    const country = address?.country_code ?? this.countryOf(parties.address_id)
    const details = previewDetails(items, currency, country)
    return this.ok(
      context,
      200,
      {
        customer_id: parties.customer_id,
        address_id: parties.address_id,
        business_id: parties.business_id,
        currency_code: currency,
        discount_id: null,
        customer_ip_address: null,
        address,
        ignore_trials: body.ignore_trials === true,
        items: items.map((item) => ({
          price: item.price,
          quantity: item.quantity,
          include_in_totals: item.counted !== false,
          proration: null,
        })),
        details,
        available_payment_methods: ["card", "paypal", "apple_pay", "google_pay"],
      },
      {},
    )
  }

  private getTransaction(context: OperationContext): Response {
    const include = this.includes(context, TRANSACTION_INCLUDES)
    const transaction = this.mustTransaction(context.params.transaction_id ?? "")
    return this.ok(context, 200, this.renderTransaction(transaction, include), {
      transactionId: transaction.id,
    })
  }

  private updateTransaction(context: OperationContext): Response {
    const include = this.includes(context, TRANSACTION_INCLUDES)
    const transaction = this.mustTransaction(context.params.transaction_id ?? "")
    const body = this.body(context)
    const target = str(body.status)
    const cancelOnly = transaction.status === "billed" || transaction.status === "past_due"
    if (
      !["draft", "ready"].includes(transaction.status) &&
      !(cancelOnly && target === "canceled")
    ) {
      throw new PaddleError(
        400,
        "transaction_immutable",
        `Transaction ${transaction.id} is ${transaction.status} and can no longer be updated`,
      )
    }
    const updated = this.transactionFrom(body as TransactionInput, transaction, transaction.origin)
    this.state.transactions.update(transaction.id, updated)
    this.transactionEvents(updated, false)
    return this.ok(context, 200, this.renderTransaction(updated, include), {
      transactionId: transaction.id,
    })
  }

  private transactionInvoice(context: OperationContext): Response {
    const transaction = this.mustTransaction(context.params.transaction_id ?? "")
    if (!["billed", "paid", "completed"].includes(transaction.status)) {
      throw new PaddleError(
        400,
        "transaction_invoice_not_available",
        `Transaction ${transaction.id} is ${transaction.status}; invoices exist for billed, paid and completed transactions`,
      )
    }
    const disposition = str(context.query.disposition) ?? "attachment"
    return this.ok(
      context,
      200,
      {
        url: `${context.url.origin}${this.prefix()}/invoices/${transaction.invoice_id ?? transaction.id}.pdf?disposition=${disposition}`,
      },
      { transactionId: transaction.id },
    )
  }

  // ---------------------------------------------------------------------------------------
  // Paying, renewing and failing: what Paddle's checkout and billing engine do

  private captured(transaction: TransactionRecord, card: CardInput | undefined): PaymentAttempt {
    const customer = transaction.customer_id
      ? this.state.customers.get(transaction.customer_id)
      : undefined
    const year = new Date(this.now()).getUTCFullYear() + 3
    const at = this.iso()
    return {
      payment_attempt_id: this.state.nextId("payment_attempt"),
      stored_payment_method_id: this.state.nextId("payment_method"),
      payment_method_id: this.state.nextId("payment_method"),
      amount: transaction.details.totals.grand_total,
      status: "captured",
      error_code: null,
      method_details: {
        type: "card",
        card: {
          type: card?.type ?? "visa",
          last4: card?.last4 ?? "4242",
          expiry_month: card?.expiry_month ?? 12,
          expiry_year: card?.expiry_year ?? year,
          cardholder_name: card?.cardholder_name ?? customer?.name ?? "Card Holder",
        },
        paypal: null,
        south_korea_local_card: null,
        underlying_details: null,
      },
      created_at: at,
      captured_at: at,
    }
  }

  private subscriptionItems(
    transaction: TransactionRecord,
    at: string,
    trialing: boolean,
  ): SubscriptionItem[] {
    return transaction.items
      .filter((item) => item.price.billing_cycle !== null)
      .map((item) => {
        const trial = item.price.trial_period
        const onTrial = trialing && trial !== null
        const trialEnd = trial ? addPeriod(at, trial) : null
        return {
          status: onTrial ? "trialing" : "active",
          quantity: item.quantity,
          recurring: true,
          created_at: at,
          updated_at: at,
          previously_billed_at: onTrial ? null : at,
          next_billed_at: onTrial
            ? trialEnd
            : addPeriod(at, item.price.billing_cycle as TimePeriod),
          trial_dates: trial && trialEnd ? { starts_at: at, ends_at: trialEnd } : null,
          price: item.price,
          product: this.state.products.get(item.price.product_id) as ProductRecord,
        }
      })
  }

  /**
   * Complete a `ready`, `billed` or `past_due` transaction as if the customer paid: a captured
   * card payment, `completed` status, an invoice, and, for recurring items, the subscription
   * (`trialing` when a price has a trial, else `active`) or the recovery of a past-due one.
   */
  payTransaction(
    id: string,
    card?: CardInput,
  ): { transaction: TransactionRecord; subscription: SubscriptionRecord | null } {
    const transaction = this.mustTransaction(id)
    if (!["ready", "billed", "past_due"].includes(transaction.status)) {
      throw new PaddleError(
        400,
        "transaction_not_payable",
        `Transaction ${id} is ${transaction.status}; only ready, billed and past_due transactions can be paid`,
      )
    }
    const recurring = transaction.items.filter((i) => i.price.billing_cycle !== null)
    if (recurring.length > 0 && transaction.subscription_id === null) {
      if (transaction.customer_id === null || transaction.address_id === null) {
        throw new PaddleError(
          400,
          "transaction_missing_customer",
          `Transaction ${id} needs customer_id and address_id before a subscription can be created`,
        )
      }
    }
    const at = this.iso()
    let subscription: SubscriptionRecord | null = null
    const paid: TransactionRecord = {
      ...transaction,
      status: "completed",
      payments: [...transaction.payments, this.captured(transaction, card)],
      invoice_id: transaction.invoice_id ?? this.state.nextId("invoice"),
      invoice_number: transaction.invoice_number ?? this.nextInvoiceNumber(),
      billed_at: transaction.billed_at ?? at,
      updated_at: at,
    }
    if (recurring.length > 0 && transaction.subscription_id === null) {
      const trialing = recurring.some((i) => i.price.trial_period !== null)
      const cycle = recurring[0]?.price.billing_cycle as TimePeriod
      const items = this.subscriptionItems(transaction, at, trialing)
      const nextBilledAt = items.reduce<string | null>(
        (min, item) =>
          item.next_billed_at !== null && (min === null || item.next_billed_at < min)
            ? item.next_billed_at
            : min,
        null,
      )
      const period: Period = { starts_at: at, ends_at: nextBilledAt ?? addPeriod(at, cycle) }
      subscription = {
        id: this.state.nextId("subscription"),
        status: trialing ? "trialing" : "active",
        customer_id: transaction.customer_id as string,
        address_id: transaction.address_id as string,
        business_id: transaction.business_id,
        currency_code: transaction.currency_code,
        created_at: at,
        updated_at: at,
        started_at: at,
        first_billed_at: trialing ? null : at,
        next_billed_at: period.ends_at,
        paused_at: null,
        canceled_at: null,
        discount: null,
        collection_mode: transaction.collection_mode,
        billing_details: transaction.billing_details,
        current_billing_period: period,
        billing_cycle: cycle,
        scheduled_change: null,
        management_urls: { update_payment_method: null, cancel: "" },
        items,
        custom_data: transaction.custom_data,
        import_meta: null,
      }
      this.state.subscriptions.insert(subscription.id, subscription)
      paid.subscription_id = subscription.id
      paid.billing_period = period
      if (transaction.origin === "api") paid.origin = "web"
    }
    this.state.transactions.update(paid.id, paid)
    this.emit("transaction.paid", { ...paid, status: "paid" })
    this.emit("transaction.completed", paid)
    if (subscription) {
      this.emit("subscription.created", { ...subscription, transaction_id: paid.id })
      this.emit(
        subscription.status === "trialing" ? "subscription.trialing" : "subscription.activated",
        subscription,
      )
    } else if (transaction.subscription_id) {
      const existing = this.state.subscriptions.get(transaction.subscription_id)
      if (existing && existing.status === "past_due" && paid.billing_period) {
        const recovered: SubscriptionRecord = {
          ...existing,
          status: "active",
          current_billing_period: paid.billing_period,
          next_billed_at: paid.billing_period.ends_at,
          updated_at: at,
          items: existing.items.map((item) =>
            item.recurring
              ? {
                  ...item,
                  previously_billed_at: paid.billing_period?.starts_at ?? at,
                  next_billed_at: paid.billing_period?.ends_at ?? null,
                  updated_at: at,
                }
              : item,
          ),
        }
        this.state.subscriptions.update(recovered.id, recovered)
        this.emit("subscription.updated", recovered)
        subscription = recovered
      }
    }
    return { transaction: paid, subscription }
  }

  private mustSubscription(id: string): SubscriptionRecord {
    const subscription = this.state.subscriptions.get(id)
    if (!subscription) throw notFound(id)
    return subscription
  }

  private saveSubscription(subscription: SubscriptionRecord, event: string): SubscriptionRecord {
    this.state.subscriptions.update(subscription.id, subscription)
    this.emit(event, subscription)
    return subscription
  }

  private recurringPriced(subscription: SubscriptionRecord): Priced[] {
    return subscription.items
      .filter((item) => item.recurring && item.status !== "inactive")
      .map((item) => ({ price: item.price, product: item.product, quantity: item.quantity }))
  }

  private applyScheduledChange(
    subscription: SubscriptionRecord,
    at: string,
  ): SubscriptionRecord | null {
    const change = subscription.scheduled_change
    if (!change) return null
    if (change.action === "cancel") {
      return this.saveSubscription(
        {
          ...subscription,
          status: "canceled",
          canceled_at: change.effective_at,
          next_billed_at: null,
          current_billing_period: null,
          scheduled_change: null,
          items: subscription.items.map((item) => ({
            ...item,
            status: "inactive",
            next_billed_at: null,
            updated_at: at,
          })),
          updated_at: at,
        },
        "subscription.canceled",
      )
    }
    if (change.action === "pause") {
      return this.saveSubscription(
        {
          ...subscription,
          status: "paused",
          paused_at: change.effective_at,
          next_billed_at: null,
          current_billing_period: null,
          scheduled_change: change.resume_at
            ? { action: "resume", effective_at: change.resume_at, resume_at: null }
            : null,
          items: subscription.items.map((item) => ({
            ...item,
            next_billed_at: null,
            updated_at: at,
          })),
          updated_at: at,
        },
        "subscription.paused",
      )
    }
    return null
  }

  /** A completed transaction for a subscription's billing period (renewal, charge, update). */
  private billSubscription(
    subscription: SubscriptionRecord,
    items: Priced[],
    origin: TransactionOrigin,
    period: Period | null,
    outcome: "completed" | "past_due",
  ): TransactionRecord {
    const at = this.iso()
    const id = this.state.nextId("transaction")
    const lines = this.lineItems(items, this.countryOf(subscription.address_id))
    const base: TransactionRecord = {
      id,
      status: "ready",
      customer_id: subscription.customer_id,
      address_id: subscription.address_id,
      business_id: subscription.business_id,
      custom_data: subscription.custom_data,
      currency_code: subscription.currency_code,
      origin,
      subscription_id: subscription.id,
      invoice_id: null,
      invoice_number: null,
      collection_mode: subscription.collection_mode,
      discount_id: null,
      billing_details: subscription.billing_details,
      billing_period: period,
      items: items.map((item) => ({
        price_id: item.price.id,
        price: item.price,
        quantity: item.quantity,
        proration: null,
      })),
      details: transactionDetails(lines, subscription.currency_code),
      payments: [],
      checkout: { url: null },
      created_at: at,
      updated_at: at,
      billed_at: null,
      revised_at: null,
    }
    this.state.transactions.insert(id, base)
    this.emit("transaction.created", base)
    if (outcome === "past_due") {
      const failed: TransactionRecord = {
        ...base,
        status: "past_due",
        payments: [
          {
            ...this.captured(base, undefined),
            status: "error",
            error_code: "declined",
            captured_at: null,
          },
        ],
        updated_at: at,
      }
      this.state.transactions.update(id, failed)
      this.emit("transaction.payment_failed", failed)
      this.emit("transaction.past_due", failed)
      return failed
    }
    const paid: TransactionRecord = {
      ...base,
      status: "completed",
      payments: [this.captured(base, undefined)],
      invoice_id: this.state.nextId("invoice"),
      invoice_number: this.nextInvoiceNumber(),
      billed_at: at,
      updated_at: at,
    }
    this.state.transactions.update(id, paid)
    this.emit("transaction.billed", { ...paid, status: "billed" })
    this.emit("transaction.paid", { ...paid, status: "paid" })
    this.emit("transaction.completed", paid)
    return paid
  }

  /**
   * Run the next billing date: a scheduled cancel or pause takes effect instead, a paused
   * subscription with a scheduled resume resumes (billed from its `effective_at`); otherwise a
   * `subscription_recurring` transaction is created (plus any queued one-time charges), the
   * billing period advances, and a trial ends into `active`.
   */
  renewSubscription(id: string): {
    subscription: SubscriptionRecord
    transaction: TransactionRecord | null
  } {
    const subscription = this.mustSubscription(id)
    if (subscription.status === "paused" && subscription.scheduled_change?.action === "resume") {
      const start = subscription.scheduled_change.effective_at
      return this.resumeInto(
        subscription,
        { starts_at: start, ends_at: addPeriod(start, subscription.billing_cycle) },
        this.iso(),
      )
    }
    if (subscription.status !== "active" && subscription.status !== "trialing") {
      throw new PaddleError(
        400,
        "subscription_not_renewable",
        `Subscription ${id} is ${subscription.status}; only active and trialing subscriptions renew`,
      )
    }
    const at = this.iso()
    const changed = this.applyScheduledChange(subscription, at)
    if (changed) return { subscription: changed, transaction: null }
    const start = subscription.next_billed_at ?? subscription.current_billing_period?.ends_at ?? at
    const period: Period = {
      starts_at: start,
      ends_at: addPeriod(start, subscription.billing_cycle),
    }
    const pending = this.state.pendingCharges.get(subscription.id) ?? []
    const charges: Priced[] = pending.flatMap((charge) => {
      const price = this.state.prices.get(charge.price_id)
      const product = price ? this.state.products.get(price.product_id) : undefined
      return price && product ? [{ price, product, quantity: charge.quantity }] : []
    })
    const transaction = this.billSubscription(
      subscription,
      [...this.recurringPriced(subscription), ...charges],
      "subscription_recurring",
      period,
      "completed",
    )
    if (pending.length > 0) this.state.pendingCharges.delete(subscription.id)
    const wasTrialing = subscription.status === "trialing"
    const renewed: SubscriptionRecord = {
      ...subscription,
      status: "active",
      first_billed_at: subscription.first_billed_at ?? period.starts_at,
      current_billing_period: period,
      next_billed_at: period.ends_at,
      updated_at: at,
      items: subscription.items.map((item) =>
        item.recurring && item.status !== "inactive"
          ? {
              ...item,
              status: "active",
              previously_billed_at: period.starts_at,
              next_billed_at: period.ends_at,
              updated_at: at,
            }
          : item,
      ),
    }
    this.state.subscriptions.update(renewed.id, renewed)
    if (wasTrialing) this.emit("subscription.activated", renewed)
    this.emit("subscription.updated", renewed)
    return { subscription: renewed, transaction }
  }

  /** The next renewal's payment is declined: a `past_due` transaction and subscription. */
  failPayment(id: string): { subscription: SubscriptionRecord; transaction: TransactionRecord } {
    const subscription = this.mustSubscription(id)
    if (subscription.status !== "active" && subscription.status !== "trialing") {
      throw new PaddleError(
        400,
        "subscription_not_renewable",
        `Subscription ${id} is ${subscription.status}; only active and trialing subscriptions are billed`,
      )
    }
    const at = this.iso()
    const start = subscription.next_billed_at ?? subscription.current_billing_period?.ends_at ?? at
    const period: Period = {
      starts_at: start,
      ends_at: addPeriod(start, subscription.billing_cycle),
    }
    const transaction = this.billSubscription(
      subscription,
      this.recurringPriced(subscription),
      "subscription_recurring",
      period,
      "past_due",
    )
    const pastDue = this.saveSubscription(
      { ...subscription, status: "past_due", updated_at: at },
      "subscription.past_due",
    )
    return { subscription: pastDue, transaction }
  }

  /** A hosted-checkout completion in one call: find or create the customer and address, then pay. */
  checkout(input: CheckoutInput): {
    transaction: TransactionRecord
    subscription: SubscriptionRecord | null
  } {
    let customer = input.customer_id ? this.mustCustomer(input.customer_id) : undefined
    if (!customer) {
      const email = input.email?.trim()
      if (!email) throw badRequest("customer_id or email is required")
      customer =
        this.state.customers.list({
          where: (c) => c.email.toLowerCase() === email.toLowerCase(),
        })[0]?.value ?? this.createCustomer({ email, name: input.name ?? null })
    }
    const customerId = customer.id
    let address = input.address_id ? this.mustAddress(customerId, input.address_id) : undefined
    if (!address) {
      address =
        this.state.addresses.list({
          where: (a) =>
            a.customer_id === customerId &&
            a.status === "active" &&
            (input.country_code === undefined || a.country_code === input.country_code),
        })[0]?.value ??
        this.createAddress(customerId, {
          country_code: input.country_code ?? "US",
          postal_code: input.postal_code ?? null,
        })
    }
    const transaction = this.createTransaction(
      {
        items: input.items.map((item) => ({
          price_id: item.price_id,
          quantity: item.quantity ?? 1,
        })),
        customer_id: customerId,
        address_id: address.id,
        business_id: input.business_id ?? null,
        custom_data: input.custom_data ?? null,
        ...(input.currency_code ? { currency_code: input.currency_code } : {}),
      },
      "web",
    )
    return this.payTransaction(transaction.id)
  }

  // ---------------------------------------------------------------------------------------
  // Subscriptions

  private nextTransactionPreview(subscription: SubscriptionRecord, origin: string) {
    if (subscription.status === "canceled" || subscription.next_billed_at === null) return null
    const start = subscription.next_billed_at
    return {
      billing_period: { starts_at: start, ends_at: addPeriod(start, subscription.billing_cycle) },
      details: previewDetails(
        this.recurringPriced(subscription),
        subscription.currency_code,
        this.countryOf(subscription.address_id),
      ),
      adjustments: [],
      ...(origin ? {} : {}),
    }
  }

  private renderSubscription(
    subscription: SubscriptionRecord,
    include: Set<string>,
    origin: string,
  ) {
    const token = opaqueToken(`paddle-manage:${subscription.id}`, 32)
    const base = `${origin}${this.prefix()}/subscription/${subscription.id}`
    return {
      ...subscription,
      management_urls: {
        update_payment_method: `${base}/update-payment-method?token=${token}`,
        cancel: `${base}/cancel?token=${token}`,
      },
      ...(include.has("next_transaction")
        ? { next_transaction: this.nextTransactionPreview(subscription, origin) }
        : {}),
      ...(include.has("recurring_transaction_details")
        ? {
            recurring_transaction_details: previewDetails(
              this.recurringPriced(subscription),
              subscription.currency_code,
              this.countryOf(subscription.address_id),
            ),
          }
        : {}),
    }
  }

  private listSubscriptions(context: OperationContext): Response {
    const ids = listParam(context.query.id)
    const customerIds = listParam(context.query.customer_id)
    const addressIds = listParam(context.query.address_id)
    const priceIds = listParam(context.query.price_id)
    const statuses = listParam(context.query.status)
    const collectionMode = str(context.query.collection_mode)
    const actions = listParam(context.query.scheduled_change_action)
    const rows = this.state.subscriptions
      .list({
        where: (s) =>
          (ids === undefined || ids.includes(s.id)) &&
          (customerIds === undefined || customerIds.includes(s.customer_id)) &&
          (addressIds === undefined || addressIds.includes(s.address_id)) &&
          (priceIds === undefined || s.items.some((i) => priceIds.includes(i.price.id))) &&
          (statuses === undefined || statuses.includes(s.status)) &&
          (collectionMode === undefined || s.collection_mode === collectionMode) &&
          (actions === undefined ||
            (s.scheduled_change !== null && actions.includes(s.scheduled_change.action))),
      })
      .map((row) => row.value)
    const page = paginate(context, this.prefix(), rows, {
      defaultPerPage: DEFAULT_PER_PAGE,
      maxPerPage: MAX_PER_PAGE,
    })
    return envelope(
      200,
      page.data.map((s) => this.renderSubscription(s, new Set(), context.url.origin)),
      this.requestId(context.request),
      page.pagination,
    )
  }

  private subscriptionResponse(
    context: OperationContext,
    subscription: SubscriptionRecord,
    include = new Set<string>(),
  ) {
    return this.ok(
      context,
      200,
      this.renderSubscription(subscription, include, context.url.origin),
      {
        subscriptionId: subscription.id,
      },
    )
  }

  private getSubscription(context: OperationContext): Response {
    const include = this.includes(context, SUBSCRIPTION_INCLUDES)
    const subscription = this.mustSubscription(context.params.subscription_id ?? "")
    return this.subscriptionResponse(context, subscription, include)
  }

  private notCanceled(subscription: SubscriptionRecord, action: string) {
    if (subscription.status === "canceled") {
      throw new PaddleError(
        400,
        "subscription_update_when_canceled",
        `Subscription ${subscription.id} is canceled and cannot be ${action}`,
      )
    }
  }

  private updateSubscription(context: OperationContext): Response {
    const subscription = this.mustSubscription(context.params.subscription_id ?? "")
    this.notCanceled(subscription, "updated")
    const body = this.body(context)
    const errors: FieldError[] = []
    const parties = this.resolveParties(
      {
        customer_id: body.customer_id ?? subscription.customer_id,
        address_id: body.address_id ?? subscription.address_id,
        business_id: body.business_id === undefined ? subscription.business_id : body.business_id,
      },
      errors,
    )
    if (parties.customer_id === null || parties.address_id === null) {
      errors.push({
        field: "customer_id",
        message: "customer_id: a subscription needs a customer and address",
      })
    }
    const currency = str(body.currency_code) ?? subscription.currency_code
    let items = subscription.items
    let priced: Priced[] | undefined
    const catalog: (() => void)[] = []
    const prorationMode = str(body.proration_billing_mode)
    if (body.items !== undefined) {
      priced = this.resolveItems(body.items, "items", errors, catalog)
      if (prorationMode === undefined) {
        errors.push({
          field: "proration_billing_mode",
          message: "proration_billing_mode: required when items change",
        })
      }
      const recurring = priced.filter((i) => i.price.billing_cycle !== null)
      if (recurring.length === 0) {
        errors.push({
          field: "items",
          message: "items: a subscription needs at least one recurring item",
        })
      }
      if (recurring.some((i) => !samePeriod(i.price.billing_cycle, subscription.billing_cycle))) {
        errors.push({
          field: "items",
          message: `items: recurring prices must bill every ${subscription.billing_cycle.frequency} ${subscription.billing_cycle.interval}`,
        })
      }
      priced.forEach((item, index) => {
        if (item.price.unit_price.currency_code !== currency) {
          errors.push({
            field: `items[${index}].price_id`,
            message: `items[${index}].price_id: price is in ${item.price.unit_price.currency_code}, subscription is in ${currency}`,
          })
        }
      })
    }
    if (body.scheduled_change !== undefined && body.scheduled_change !== null) {
      errors.push({
        field: "scheduled_change",
        message:
          "scheduled_change: only null is accepted (use the pause, resume and cancel operations to schedule a change)",
      })
    }
    const nextBilledAt = str(body.next_billed_at)
    if (nextBilledAt !== undefined && Number.isNaN(Date.parse(nextBilledAt))) {
      errors.push({
        field: "next_billed_at",
        message: "next_billed_at: must be an RFC 3339 datetime",
      })
    }
    const billingDetails =
      body.billing_details === undefined
        ? subscription.billing_details
        : this.billingDetails(body.billing_details, errors)
    const collectionMode =
      (str(body.collection_mode) as CollectionMode | undefined) ?? subscription.collection_mode
    if (collectionMode === "manual" && !billingDetails) {
      errors.push({
        field: "billing_details",
        message: "billing_details: required when collection_mode is manual",
      })
    }
    if (errors.length > 0) throw invalidField(errors)
    for (const commit of catalog) commit()
    const at = this.iso()
    if (priced) {
      const existing = new Map(subscription.items.map((item) => [item.price.id, item]))
      items = priced.map((item) => {
        const previous = existing.get(item.price.id)
        const recurring = item.price.billing_cycle !== null
        return {
          status: previous?.status ?? (recurring ? "active" : "inactive"),
          quantity: item.quantity,
          recurring,
          created_at: previous?.created_at ?? at,
          updated_at: at,
          previously_billed_at: previous?.previously_billed_at ?? (recurring ? at : null),
          next_billed_at: recurring ? subscription.next_billed_at : null,
          trial_dates: previous?.trial_dates ?? null,
          price: item.price,
          product: item.product,
        }
      })
    }
    const updated: SubscriptionRecord = {
      ...subscription,
      customer_id: parties.customer_id as string,
      address_id: parties.address_id as string,
      business_id: parties.business_id,
      currency_code: currency,
      next_billed_at: nextBilledAt ?? subscription.next_billed_at,
      collection_mode: collectionMode,
      billing_details: billingDetails,
      scheduled_change: body.scheduled_change === null ? null : subscription.scheduled_change,
      items,
      custom_data: customData(body.custom_data, subscription.custom_data),
      updated_at: at,
    }
    this.state.subscriptions.update(updated.id, updated)
    if (
      priced &&
      (prorationMode === "prorated_immediately" || prorationMode === "full_immediately")
    ) {
      // What the change adds (new prices, quantity increases) is billed now, in full; there is
      // no proration and nothing is credited for what it removes.
      const before = new Map(subscription.items.map((item) => [item.price.id, item.quantity]))
      const added = priced.flatMap((item) => {
        const delta = item.quantity - (before.get(item.price.id) ?? 0)
        return delta > 0 ? [{ ...item, quantity: delta }] : []
      })
      if (added.length > 0) {
        this.billSubscription(
          updated,
          added,
          "subscription_update",
          updated.current_billing_period,
          "completed",
        )
      }
    }
    this.emit("subscription.updated", updated)
    return this.subscriptionResponse(context, updated)
  }

  private activateSubscription(context: OperationContext): Response {
    const subscription = this.mustSubscription(context.params.subscription_id ?? "")
    if (subscription.status !== "trialing") {
      throw new PaddleError(
        400,
        "subscription_not_trialing",
        `Subscription ${subscription.id} is ${subscription.status}; only trialing subscriptions can be activated`,
      )
    }
    const at = this.iso()
    const period: Period = { starts_at: at, ends_at: addPeriod(at, subscription.billing_cycle) }
    const activated: SubscriptionRecord = {
      ...subscription,
      status: "active",
      first_billed_at: at,
      current_billing_period: period,
      next_billed_at: period.ends_at,
      scheduled_change: null,
      updated_at: at,
      items: subscription.items.map((item) =>
        item.recurring
          ? {
              ...item,
              status: "active",
              previously_billed_at: at,
              next_billed_at: period.ends_at,
              updated_at: at,
            }
          : item,
      ),
    }
    this.state.subscriptions.update(activated.id, activated)
    this.billSubscription(
      activated,
      this.recurringPriced(activated),
      "subscription_update",
      period,
      "completed",
    )
    this.emit("subscription.activated", activated)
    this.emit("subscription.updated", activated)
    return this.subscriptionResponse(context, activated)
  }

  private pauseSubscription(context: OperationContext): Response {
    const subscription = this.mustSubscription(context.params.subscription_id ?? "")
    this.notCanceled(subscription, "paused")
    if (subscription.status === "paused") {
      throw new PaddleError(
        400,
        "subscription_already_paused",
        `Subscription ${subscription.id} is already paused`,
      )
    }
    const body = this.body(context)
    const effectiveFrom = nullableStr(body.effective_from, null) ?? "next_billing_period"
    const resumeAt = nullableStr(body.resume_at, null)
    if (resumeAt !== null && Number.isNaN(Date.parse(resumeAt))) {
      throw invalidField([
        { field: "resume_at", message: "resume_at: must be an RFC 3339 datetime" },
      ])
    }
    const at = this.iso()
    if (effectiveFrom === "next_billing_period" && subscription.next_billed_at !== null) {
      const change: ScheduledChange = {
        action: "pause",
        effective_at: subscription.next_billed_at,
        resume_at: resumeAt,
      }
      return this.subscriptionResponse(
        context,
        this.saveSubscription(
          { ...subscription, scheduled_change: change, updated_at: at },
          "subscription.updated",
        ),
      )
    }
    const paused = this.saveSubscription(
      {
        ...subscription,
        status: "paused",
        paused_at: at,
        next_billed_at: null,
        current_billing_period: null,
        scheduled_change: resumeAt
          ? { action: "resume", effective_at: resumeAt, resume_at: null }
          : null,
        items: subscription.items.map((item) => ({
          ...item,
          next_billed_at: null,
          updated_at: at,
        })),
        updated_at: at,
      },
      "subscription.paused",
    )
    return this.subscriptionResponse(context, paused)
  }

  private resumeSubscription(context: OperationContext): Response {
    const subscription = this.mustSubscription(context.params.subscription_id ?? "")
    this.notCanceled(subscription, "resumed")
    const body = this.body(context)
    const effectiveFrom = String(body.effective_from ?? "immediately")
    const onResume = str(body.on_resume) ?? "start_new_billing_period"
    const at = this.iso()
    if (subscription.status !== "paused") {
      if (subscription.scheduled_change?.action === "pause") {
        return this.subscriptionResponse(
          context,
          this.saveSubscription(
            { ...subscription, scheduled_change: null, updated_at: at },
            "subscription.updated",
          ),
        )
      }
      throw new PaddleError(
        400,
        "subscription_not_paused",
        `Subscription ${subscription.id} is ${subscription.status}; only paused subscriptions can be resumed`,
      )
    }
    if (effectiveFrom !== "immediately") {
      if (Number.isNaN(Date.parse(effectiveFrom))) {
        throw invalidField([
          {
            field: "effective_from",
            message: "effective_from: must be immediately or an RFC 3339 datetime",
          },
        ])
      }
      const change: ScheduledChange = {
        action: "resume",
        effective_at: effectiveFrom,
        resume_at: null,
      }
      return this.subscriptionResponse(
        context,
        this.saveSubscription(
          { ...subscription, scheduled_change: change, updated_at: at },
          "subscription.updated",
        ),
      )
    }
    const previous = subscription.current_billing_period
    const period: Period =
      onResume === "continue_existing_billing_period" && previous && previous.ends_at > at
        ? previous
        : { starts_at: at, ends_at: addPeriod(at, subscription.billing_cycle) }
    const { subscription: resumed } = this.resumeInto(subscription, period, at)
    return this.subscriptionResponse(context, resumed)
  }

  /**
   * A paused subscription becomes active for `period`; a period starting now (or one a
   * scheduled resume set) is billed at once, a continued one is not.
   */
  private resumeInto(
    subscription: SubscriptionRecord,
    period: Period,
    at: string,
  ): { subscription: SubscriptionRecord; transaction: TransactionRecord | null } {
    const resumed: SubscriptionRecord = {
      ...subscription,
      status: "active",
      paused_at: null,
      current_billing_period: period,
      next_billed_at: period.ends_at,
      scheduled_change: null,
      updated_at: at,
      items: subscription.items.map((item) =>
        item.recurring && item.status !== "inactive"
          ? {
              ...item,
              previously_billed_at: period.starts_at,
              next_billed_at: period.ends_at,
              updated_at: at,
            }
          : item,
      ),
    }
    this.state.subscriptions.update(resumed.id, resumed)
    const continued = subscription.current_billing_period === period
    const transaction = continued
      ? null
      : this.billSubscription(
          resumed,
          this.recurringPriced(resumed),
          "subscription_update",
          period,
          "completed",
        )
    this.emit("subscription.resumed", resumed)
    return { subscription: resumed, transaction }
  }

  private cancelSubscription(context: OperationContext): Response {
    const subscription = this.mustSubscription(context.params.subscription_id ?? "")
    this.notCanceled(subscription, "canceled")
    const body = this.body(context)
    const effectiveFrom = nullableStr(body.effective_from, null) ?? "next_billing_period"
    const at = this.iso()
    if (effectiveFrom === "next_billing_period" && subscription.next_billed_at !== null) {
      const change: ScheduledChange = {
        action: "cancel",
        effective_at: subscription.next_billed_at,
        resume_at: null,
      }
      return this.subscriptionResponse(
        context,
        this.saveSubscription(
          { ...subscription, scheduled_change: change, updated_at: at },
          "subscription.updated",
        ),
      )
    }
    const canceled = this.saveSubscription(
      {
        ...subscription,
        status: "canceled",
        canceled_at: at,
        next_billed_at: null,
        current_billing_period: null,
        scheduled_change: null,
        items: subscription.items.map((item) => ({
          ...item,
          status: "inactive",
          next_billed_at: null,
          updated_at: at,
        })),
        updated_at: at,
      },
      "subscription.canceled",
    )
    return this.subscriptionResponse(context, canceled)
  }

  private chargeSubscription(context: OperationContext): Response {
    const subscription = this.mustSubscription(context.params.subscription_id ?? "")
    this.notCanceled(subscription, "charged")
    if (subscription.status === "paused") {
      throw new PaddleError(
        400,
        "subscription_paused",
        `Subscription ${subscription.id} is paused and cannot be charged`,
      )
    }
    const body = this.body(context)
    const errors: FieldError[] = []
    const catalog: (() => void)[] = []
    const items = this.resolveItems(body.items, "items", errors, catalog)
    items.forEach((item, index) => {
      if (item.price.billing_cycle !== null) {
        errors.push({
          field: `items[${index}].price_id`,
          message: `items[${index}].price_id: one-time charges take non-recurring prices`,
        })
      }
      if (item.price.unit_price.currency_code !== subscription.currency_code) {
        errors.push({
          field: `items[${index}].price_id`,
          message: `items[${index}].price_id: price is in ${item.price.unit_price.currency_code}, subscription is in ${subscription.currency_code}`,
        })
      }
    })
    const effectiveFrom = str(body.effective_from)
    if (effectiveFrom !== "immediately" && effectiveFrom !== "next_billing_period") {
      errors.push({
        field: "effective_from",
        message: "effective_from: must be immediately or next_billing_period",
      })
    }
    if (errors.length > 0) throw invalidField(errors)
    for (const commit of catalog) commit()
    const at = this.iso()
    if (effectiveFrom === "immediately") {
      this.billSubscription(
        subscription,
        items,
        "subscription_charge",
        subscription.current_billing_period,
        "completed",
      )
    } else {
      const pending: PendingCharge[] = [
        ...(this.state.pendingCharges.get(subscription.id) ?? []),
        ...items.map((item) => ({ price_id: item.price.id, quantity: item.quantity })),
      ]
      if (this.state.pendingCharges.has(subscription.id))
        this.state.pendingCharges.update(subscription.id, pending)
      else this.state.pendingCharges.insert(subscription.id, pending)
    }
    const updated = this.saveSubscription(
      { ...subscription, updated_at: at },
      "subscription.updated",
    )
    return this.subscriptionResponse(context, updated)
  }

  // ---------------------------------------------------------------------------------------
  // Events

  private listEvents(context: OperationContext): Response {
    const rows = this.state.events.list().map((row) => ({ ...row.value, id: row.value.event_id }))
    const page = paginate(context, this.prefix(), rows, {
      defaultPerPage: DEFAULT_PER_PAGE,
      maxPerPage: MAX_PER_PAGE,
    })
    return envelope(
      200,
      page.data.map(({ id: _id, ...event }) => event),
      this.requestId(context.request),
      page.pagination,
    )
  }

  // ---------------------------------------------------------------------------------------
  // Fixtures

  /**
   * A small account to start from: a customer with an address and a business, a "Pro" product
   * with monthly, yearly and one-time prices, a "Starter" price with a 14-day trial, an active
   * monthly subscription, a trialing one, an unpaid `ready` transaction and a manual invoice.
   * Deterministic: two instances seeded at the same clock hold identical ids.
   */
  seedFixtures(): {
    customer: CustomerRecord
    address: AddressRecord
    business: BusinessRecord
    product: ProductRecord
    prices: { monthly: PriceRecord; yearly: PriceRecord; setup: PriceRecord; starter: PriceRecord }
    subscriptions: { active: SubscriptionRecord; trialing: SubscriptionRecord }
    transactions: { ready: TransactionRecord; invoice: TransactionRecord }
  } {
    const wasSeeding = this.seeding
    this.seeding = true
    try {
      return this.seedAccount()
    } finally {
      this.seeding = wasSeeding
    }
  }

  private seedAccount(): ReturnType<PaddleAPI["seedFixtures"]> {
    const customer = this.createCustomer({ email: "ada@example.com", name: "Ada Lovelace" })
    const address = this.createAddress(customer.id, {
      country_code: "US",
      first_line: "1 Analytical Engine Way",
      city: "Cambridge",
      region: "MA",
      postal_code: "02139",
    })
    const business = this.createBusiness(customer.id, {
      name: "Analytical Engines Ltd",
      tax_identifier: "US-12-3456789",
      contacts: [{ name: "Ada Lovelace", email: "ada@example.com" }],
    })
    const product = this.createProduct({
      name: "Pro plan",
      tax_category: "saas",
      description: "Everything, monthly or yearly",
    })
    const monthly = this.createPrice({
      product_id: product.id,
      description: "Pro monthly",
      name: "Monthly",
      unit_price: { amount: "2900", currency_code: "USD" },
      billing_cycle: { interval: "month", frequency: 1 },
    })
    const yearly = this.createPrice({
      product_id: product.id,
      description: "Pro yearly",
      name: "Yearly",
      unit_price: { amount: "29000", currency_code: "USD" },
      billing_cycle: { interval: "year", frequency: 1 },
    })
    const setup = this.createPrice({
      product_id: product.id,
      description: "Onboarding session",
      name: "Onboarding",
      unit_price: { amount: "9900", currency_code: "USD" },
    })
    const starterProduct = this.createProduct({ name: "Starter plan", tax_category: "saas" })
    const starter = this.createPrice({
      product_id: starterProduct.id,
      description: "Starter monthly, 14-day trial",
      name: "Starter",
      unit_price: { amount: "1900", currency_code: "USD" },
      billing_cycle: { interval: "month", frequency: 1 },
      trial_period: { interval: "day", frequency: 14 },
    })
    const active = this.checkout({
      customer_id: customer.id,
      address_id: address.id,
      items: [{ price_id: monthly.id, quantity: 1 }],
    }).subscription as SubscriptionRecord
    const trialing = this.checkout({
      email: "grace@example.com",
      name: "Grace Hopper",
      country_code: "GB",
      items: [{ price_id: starter.id, quantity: 1 }],
    }).subscription as SubscriptionRecord
    const ready = this.createTransaction({
      items: [{ price_id: setup.id, quantity: 1 }],
      customer_id: customer.id,
      address_id: address.id,
    })
    const invoice = this.createTransaction({
      items: [{ price_id: yearly.id, quantity: 2 }],
      customer_id: customer.id,
      address_id: address.id,
      business_id: business.id,
      collection_mode: "manual",
      billing_details: {
        payment_terms: { interval: "day", frequency: 30 },
        purchase_order_number: "PO-1001",
      },
      status: "billed",
    })
    return {
      customer,
      address,
      business,
      product,
      prices: { monthly, yearly, setup, starter },
      subscriptions: { active, trialing },
      transactions: { ready, invoice },
    }
  }
}

export type { PaddleRuntime, PaddleRuntimeOptions } from "./runtime.js"
export { createRuntime, PADDLE_PRESETS, paddleSigner } from "./runtime.js"
