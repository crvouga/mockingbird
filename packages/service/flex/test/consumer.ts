/**
 * A port of our backend's Flex integration (`B/billing/flex/`): the API client with its zod
 * `.passthrough()` response validation (`flex-api.client.ts`, `flex-payment.types.ts`,
 * `flex-product.types.ts`), the orchestrator's session interpretation (`resolveStatus`,
 * `applyAuthoritativeSession`, ambiguous-create recovery, refunds), the catalog validation
 * (`flex-catalog-mapping.service.ts`) and the webhook receiver (`flex-webhook-signature
 * .service.ts`, `flex-webhook.service.ts`). Persistence is an in-memory stand-in for the
 * Drizzle repository with the same status-transition guard. The acceptance tests drive the
 * mock through it, so "the mock works" means "our consumer's own logic reaches the right
 * outcome".
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { z } from "zod"

export type Fetch = (request: Request) => Promise<Response>

// --- flex-product.types.ts / the consumer's db FLEX_ELIGIBILITY_TYPES ------------------------------

export const FLEX_ELIGIBILITY_TYPES = [
  "not_eligible",
  "auto_substantiation",
  "private_label",
  "letter_of_medical_necessity",
  "prescription",
  "vision",
  "service",
] as const
export type FlexEligibilityType = (typeof FLEX_ELIGIBILITY_TYPES)[number]
export const flexKnownEligibilitySchema = z.enum(FLEX_ELIGIBILITY_TYPES)

const flexProviderEligibilitySchema = z
  .union([flexKnownEligibilitySchema, z.string().trim().min(1)])
  .nullable()

export const flexProductSchema = z
  .object({
    product_id: z.string().trim().min(1),
    client_reference_id: z.string().trim().min(1).nullable().optional(),
    hsa_fsa_eligibility: flexProviderEligibilitySchema.optional(),
    active: z.boolean(),
    test_mode: z.boolean(),
    visit_type: z.string().trim().min(1).nullable().optional(),
    metadata: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough()
export const flexProductEnvelopeSchema = z.object({ product: flexProductSchema }).passthrough()
export const flexProductListEnvelopeSchema = z
  .object({ products: z.array(flexProductSchema) })
  .passthrough()
export type FlexProduct = z.infer<typeof flexProductSchema>

// --- flex-payment.types.ts ------------------------------------------------------------------

const expandableIdSchema = (key: string) =>
  z.union([z.string(), z.record(z.unknown()).refine((value) => typeof value[key] === "string")])

const flexPaymentIntentSchema = z
  .object({
    payment_intent_id: z.string(),
    amount: z.number().int().nonnegative(),
    amount_received: z.number().int().nonnegative().nullable().optional(),
    customer: expandableIdSchema("customer_id").nullable().optional(),
    payment_method: expandableIdSchema("payment_method_id").nullable().optional(),
    status: z.string(),
  })
  .passthrough()

export const flexSetupIntentSchema = z
  .object({
    setup_intent_id: z.string(),
    status: z.string(),
    customer: expandableIdSchema("customer_id").nullable().optional(),
    payment_method: expandableIdSchema("payment_method_id").nullable().optional(),
  })
  .passthrough()
export const flexSetupIntentEnvelopeSchema = z.object({ setup_intent: flexSetupIntentSchema })

export const flexNextActionSchema = z
  .object({
    type: z.string(),
    collect_letter_of_medical_necessity: z
      .object({ url: z.string().url() })
      .passthrough()
      .optional(),
    provide_second_payment_method: z.object({ url: z.string().url() }).passthrough().optional(),
    provide_alternative_payment_method: z
      .object({ url: z.string().url() })
      .passthrough()
      .optional(),
    payment_failed: z.record(z.unknown()).optional(),
  })
  .passthrough()

const flexCheckoutSessionResponseSchema = z
  .object({
    checkout_session_id: z.string(),
    client_reference_id: z.string().nullable().optional(),
    amount_total: z.number().int().nonnegative(),
    amount_received: z.number().int().nonnegative().nullable().optional(),
    amount_refunded: z.number().int().nonnegative().nullable().optional(),
    customer: expandableIdSchema("customer_id").nullable().optional(),
    payment_intent: z.union([z.string(), flexPaymentIntentSchema]).nullable().optional(),
    payment_intents: z.array(z.union([z.string(), flexPaymentIntentSchema])).optional(),
    setup_intent: z.union([z.string(), flexSetupIntentSchema]).nullable().optional(),
    mode: z.enum(["payment", "subscription", "off_session", "setup"]).optional(),
    redirect_url: z.string().url().nullable().optional(),
    url: z.string().url().nullable().optional(),
    status: z.enum(["open", "paid", "complete", "canceled", "expired"]),
    next_action: flexNextActionSchema.nullable().optional(),
    visit_type: z.string().nullable().optional(),
    metadata: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough()

export const flexCheckoutSessionSchema = flexCheckoutSessionResponseSchema
  .refine((session) => Boolean(session.redirect_url ?? session.url), {
    message: "Flex checkout session is missing its hosted checkout URL",
  })
  .transform((session) => ({
    ...session,
    redirect_url: session.redirect_url ?? session.url ?? "",
  }))
export const flexCheckoutSessionEnvelopeSchema = z.object({
  checkout_session: flexCheckoutSessionSchema,
})
export const flexCheckoutSessionListEnvelopeSchema = z.object({
  checkout_sessions: z.array(flexCheckoutSessionSchema),
})

const flexWebhookEventSchema = z
  .object({
    event_id: z.string(),
    event_type: z.string(),
    object: z.record(z.unknown()),
    event_dt: z.number().int().optional(),
    test_mode: z.boolean().optional(),
    created_at: z.string().optional(),
  })
  .passthrough()
const flexWebhookWrappedEventSchema = z.object({ event: flexWebhookEventSchema })
export const flexWebhookEnvelopeSchema = z
  .union([flexWebhookWrappedEventSchema, flexWebhookEventSchema])
  .transform((payload) => {
    const wrapped = flexWebhookWrappedEventSchema.safeParse(payload)
    return wrapped.success ? wrapped.data : { event: flexWebhookEventSchema.parse(payload) }
  })

export const flexCustomerEnvelopeSchema = z.object({
  customer: z.object({ customer_id: z.string().min(1) }).passthrough(),
})
export const flexCreateCustomerInputSchema = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  email: z.string().trim().email(),
  phone: z.string().trim().min(1),
})

export type FlexCheckoutSession = z.infer<typeof flexCheckoutSessionSchema>
export type FlexSetupIntent = z.infer<typeof flexSetupIntentSchema>
export type FlexCreateCustomerInput = z.infer<typeof flexCreateCustomerInputSchema>
export type FlexCreateSessionInput = {
  clientReferenceId: string
  mode: "payment" | "off_session" | "setup"
  lineItems: Array<{ flexProductId: string; unitAmountCents: number; quantity: number }>
  successUrl: string
  cancelUrl: string
  setupFutureUse?: "off_session"
  customerId?: string
  paymentMethodId?: string
  metadata: Record<string, string>
}

// --- flex-api.client.ts ---------------------------------------------------------------------

export class FlexApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly responseBody: string,
  ) {
    super(message)
    this.name = "FlexApiError"
  }
}

/** Nest's ServiceUnavailableException / BadRequestException / UnauthorizedException, by status. */
export class HttpException extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "HttpException"
  }
}

export const getExpandableId = (value: unknown, key: string) => {
  if (typeof value === "string") return value
  if (typeof value !== "object" || value === null) return null
  const id = Reflect.get(value, key)
  return typeof id === "string" ? id : null
}

export const getSessionPaymentIntent = (session: FlexCheckoutSession) => {
  if (session.payment_intent) return session.payment_intent
  return session.payment_intents?.at(0) ?? null
}

export type FlexApiConfig = {
  baseUrl: string
  apiKey: string
  fetch: Fetch
  /** `FLEX_REQUEST_TIMEOUT_MS`; 15 s in the app. */
  timeoutMs?: number
}

/** `fetch` with the client's abort, even when the in-process fetch ignores the signal. */
const withAbort = (send: Fetch, request: Request, timeoutMs: number) => {
  const signal = AbortSignal.timeout(timeoutMs)
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    )
  })
  return Promise.race([send(new Request(request, { signal })), aborted])
}

export class FlexApiClient {
  constructor(private readonly config: FlexApiConfig) {}

  getExpectedTestMode() {
    const apiKey = this.config.apiKey.trim()
    if (apiKey.startsWith("fsk_test_")) return true
    if (apiKey.startsWith("fsk_")) return false
    throw new HttpException(503, "Flex API key format is invalid")
  }

  async getProduct(productId: string) {
    const normalizedProductId = productId.trim()
    if (!normalizedProductId) throw new FlexApiError("Flex product ID is required", null, "")
    const response = await this.request(
      `/v1/products/${encodeURIComponent(normalizedProductId)}`,
      { method: "GET" },
      flexProductEnvelopeSchema,
    )
    return response.product
  }

  async listProducts() {
    const allProducts: FlexProduct[] = []
    let cursor: string | undefined
    const limit = 100
    for (;;) {
      const params = new URLSearchParams({ limit: String(limit) })
      if (cursor) params.set("starting_after", cursor)
      const response = await this.request(
        `/v1/products?${params.toString()}`,
        { method: "GET" },
        flexProductListEnvelopeSchema,
      )
      allProducts.push(...response.products)
      if (response.products.length < limit) break
      cursor = response.products[response.products.length - 1]?.product_id
    }
    return allProducts
  }

  async createProduct(input: {
    name: string
    description: string
    url?: string
    client_reference_id: string
    metadata: Record<string, string>
  }) {
    const response = await this.request(
      "/v1/products",
      { method: "POST", body: JSON.stringify({ product: input }) },
      flexProductEnvelopeSchema,
    )
    return response.product
  }

  async deactivateProduct(productId: string) {
    const response = await this.request(
      `/v1/products/${encodeURIComponent(productId)}`,
      { method: "PATCH", body: JSON.stringify({ product: { active: false } }) },
      flexProductEnvelopeSchema,
    )
    return response.product
  }

  async createCheckoutSession(input: FlexCreateSessionInput, idempotencyKey: string) {
    if (input.mode === "setup" && (!input.customerId?.trim() || input.lineItems.length !== 0)) {
      throw new FlexApiError(
        "Flex setup checkout requires a customer and an empty line item list",
        null,
        "",
      )
    }
    const response = await this.request(
      "/v1/checkout/sessions",
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          checkout_session: {
            allow_promotion_codes: false,
            capture_method: "automatic",
            cancel_url: input.cancelUrl,
            client_reference_id: input.clientReferenceId,
            line_items: input.lineItems.map((lineItem) => ({
              price_data: {
                product: lineItem.flexProductId,
                unit_amount: lineItem.unitAmountCents,
              },
              quantity: lineItem.quantity,
            })),
            metadata: input.metadata,
            mode: input.mode,
            payment_method: input.paymentMethodId,
            customer: input.customerId,
            setup_future_use: input.setupFutureUse,
            success_url: input.successUrl,
          },
        }),
      },
      flexCheckoutSessionEnvelopeSchema,
    )
    return response.checkout_session
  }

  async createCustomer(input: FlexCreateCustomerInput, idempotencyKey: string) {
    const customer = flexCreateCustomerInputSchema.safeParse(input)
    if (!customer.success) throw new FlexApiError("Flex customer profile is invalid", null, "")
    const response = await this.request(
      "/v1/customers",
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          customer: {
            first_name: customer.data.firstName,
            last_name: customer.data.lastName,
            email: customer.data.email,
            phone: customer.data.phone,
          },
        }),
      },
      flexCustomerEnvelopeSchema,
    )
    return response.customer
  }

  async getCheckoutSession(providerSessionId: string) {
    const response = await this.request(
      `/v1/checkout/sessions/${encodeURIComponent(providerSessionId)}?expand_customer=true&expand_payment_intent=true`,
      { method: "GET" },
      flexCheckoutSessionEnvelopeSchema,
    )
    return response.checkout_session
  }

  async getSetupIntent(setupIntentId: string) {
    const response = await this.request(
      `/v1/setup_intents/${encodeURIComponent(setupIntentId)}?expand=customer,payment_method`,
      { method: "GET" },
      flexSetupIntentEnvelopeSchema,
    )
    return response.setup_intent
  }

  async findCheckoutSessionsByClientReference(clientReferenceId: string) {
    const query = new URLSearchParams({
      client_reference_id: clientReferenceId,
      expand_customer: "true",
      expand_payment_intent: "true",
      limit: "10",
    })
    const response = await this.request(
      `/v1/checkout/sessions?${query.toString()}`,
      { method: "GET" },
      flexCheckoutSessionListEnvelopeSchema,
    )
    return response.checkout_sessions
  }

  async refundCheckoutSession(
    providerSessionId: string,
    idempotencyKey: string,
    amountCents?: number,
  ) {
    const response = await this.request(
      `/v1/checkout/sessions/${encodeURIComponent(providerSessionId)}/refund`,
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          checkout_session: amountCents === undefined ? {} : { amount: amountCents },
        }),
      },
      flexCheckoutSessionEnvelopeSchema,
    )
    return response.checkout_session
  }

  private async request<TSchema extends z.ZodTypeAny>(
    path: string,
    init: RequestInit,
    responseSchema: TSchema,
  ): Promise<z.output<TSchema>> {
    const apiKey = this.config.apiKey.trim()
    if (!apiKey) throw new HttpException(503, "Flex payments are not configured")
    let response: Response
    try {
      response = await withAbort(
        this.config.fetch,
        new Request(`${this.config.baseUrl.replace(/\/$/, "")}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...(init.headers as Record<string, string> | undefined),
          },
        }),
        this.config.timeoutMs ?? 15_000,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error"
      throw new FlexApiError(`Flex request failed: ${message}`, null, "")
    }
    const responseBody = await response.text()
    if (!response.ok) {
      throw new FlexApiError(
        `Flex request failed with status ${response.status}`,
        response.status,
        responseBody,
      )
    }
    let payload: unknown
    try {
      payload = JSON.parse(responseBody)
    } catch {
      throw new FlexApiError("Flex returned invalid JSON", response.status, responseBody)
    }
    const parsed = responseSchema.safeParse(payload)
    if (!parsed.success) {
      throw new FlexApiError(
        `Flex returned an invalid response: ${parsed.error.message}`,
        response.status,
        responseBody,
      )
    }
    return parsed.data
  }
}

// --- flex-catalog-mapping.service.ts (validation) ------------------------------------------

export type PaymentPurpose = "membership" | "marketplace" | "rx" | "supplement"
export type CatalogMapping = {
  purpose: PaymentPurpose
  merchantProductId: string
  flexProductId: string
  eligibility: FlexEligibilityType
  visitType: string | null
  active: boolean
  metadata: Record<string, string>
}

export const getProductValidationFailure = (
  mapping: Pick<
    CatalogMapping,
    "purpose" | "merchantProductId" | "flexProductId" | "eligibility" | "metadata"
  >,
  product: FlexProduct,
  expectedTestMode: boolean,
  eligibility: FlexEligibilityType | null,
  requireConfiguredEligibilityMatch: boolean,
): string | null => {
  if (product.product_id !== mapping.flexProductId) {
    return `Flex returned product ${product.product_id} for configured product ${mapping.flexProductId}`
  }
  if (product.test_mode !== expectedTestMode) {
    return `Flex product ${product.product_id} does not match the configured API key environment`
  }
  if (!product.active) return `Flex product ${product.product_id} is inactive`
  const expectedClientReferenceId = mapping.metadata.flex_client_reference_id
  if (!expectedClientReferenceId?.trim()) {
    return `Flex mapping for ${product.product_id} is missing its client reference`
  }
  if (product.client_reference_id !== expectedClientReferenceId) {
    return `Flex product ${product.product_id} has an invalid client reference`
  }
  const providerMetadataClientReferenceId = product.metadata?.acme_client_reference_id
  if (
    product.metadata?.acme_purpose !== mapping.purpose ||
    product.metadata?.acme_merchant_product_id !== mapping.merchantProductId ||
    (providerMetadataClientReferenceId !== undefined &&
      providerMetadataClientReferenceId !== expectedClientReferenceId)
  ) {
    return `Flex product ${product.product_id} has invalid Acme correlation metadata`
  }
  if (!eligibility) return `Flex product ${product.product_id} has an unresolved eligibility`
  if (requireConfiguredEligibilityMatch && eligibility !== mapping.eligibility) {
    return `Flex product ${product.product_id} eligibility ${eligibility} does not match configured eligibility ${mapping.eligibility}`
  }
  if (mapping.purpose === "membership") {
    return eligibility === "not_eligible"
      ? `Flex membership product ${product.product_id} is not eligible`
      : null
  }
  if (mapping.purpose === "rx") {
    return eligibility !== "prescription"
      ? `Flex Rx product ${product.product_id} is not classified as prescription`
      : null
  }
  if (mapping.purpose === "marketplace") return null
  if (mapping.purpose === "supplement") {
    return eligibility === "not_eligible"
      ? `Flex supplement product ${product.product_id} is not eligible`
      : null
  }
  return `Flex product ${product.product_id} has an unrecognized purpose "${mapping.purpose}"`
}

export const validateProduct = (
  mapping: CatalogMapping,
  product: FlexProduct,
  expectedTestMode: boolean,
  requireConfiguredEligibilityMatch: boolean,
) => {
  const eligibilityResult = flexKnownEligibilitySchema.safeParse(product.hsa_fsa_eligibility)
  const eligibility = eligibilityResult.success ? eligibilityResult.data : null
  const visitType = product.visit_type ?? null
  const reason = getProductValidationFailure(
    mapping,
    product,
    expectedTestMode,
    eligibility,
    requireConfiguredEligibilityMatch,
  )
  return { active: reason === null, eligibility, visitType, reason }
}

/** The catalog service over an in-memory mapping table. */
export class FlexCatalog {
  constructor(
    readonly mappings: CatalogMapping[],
    private readonly api: FlexApiClient,
  ) {}

  /** `refreshProduct`: what a product.updated webhook does. */
  async refreshProduct(productId: string) {
    const rows = this.mappings.filter((m) => m.flexProductId === productId)
    if (rows.length === 0) return { updated: 0, active: 0 }
    let product: FlexProduct
    let expectedTestMode: boolean
    try {
      expectedTestMode = this.api.getExpectedTestMode()
      product = await this.api.getProduct(productId)
    } catch (error) {
      for (const row of rows) row.active = false
      throw error
    }
    const updates = rows.map((mapping) => ({
      mapping,
      validation: validateProduct(mapping, product, expectedTestMode, false),
    }))
    for (const { mapping, validation } of updates) {
      mapping.active = validation.active
      mapping.eligibility = validation.eligibility ?? mapping.eligibility
      mapping.visitType = validation.visitType
    }
    return { updated: updates.length, active: updates.filter((u) => u.validation.active).length }
  }

  /** `resolve`: map merchant line items to Flex products (availability rules included). */
  resolve(
    purpose: PaymentPurpose,
    lineItems: Array<{ merchantProductId: string; unitAmountCents: number; quantity: number }>,
  ) {
    const products = lineItems.map((item) => {
      const mapping = this.mappings.find(
        (m) => m.purpose === purpose && m.active && m.merchantProductId === item.merchantProductId,
      )
      return { item, mapping }
    })
    const allMapped = products.every((p) => p.mapping)
    const eligibilities = products.map((p) => p.mapping?.eligibility ?? null)
    const available =
      allMapped &&
      (purpose === "marketplace"
        ? eligibilities.some((e) => e !== null && e !== "not_eligible")
        : purpose === "rx"
          ? eligibilities.every((e) => e === "prescription")
          : eligibilities.every((e) => e !== null && e !== "not_eligible"))
    if (!available) {
      throw new HttpException(
        400,
        `Products are unavailable for Flex checkout: ${lineItems.map((i) => i.merchantProductId).join(", ")}`,
      )
    }
    return products.map(({ item, mapping }) => ({
      flexProductId: (mapping as CatalogMapping).flexProductId,
      unitAmountCents: item.unitAmountCents,
      quantity: item.quantity,
    }))
  }
}

// --- flex-payment-repository.service.ts (in memory) ----------------------------------------

export type AttemptStatus =
  | "created"
  | "pending"
  | "processing"
  | "action_required"
  | "succeeded"
  | "failed"
  | "canceled"
  | "refunded"
  | "quarantined"

export const ALLOWED_PREVIOUS_STATUSES: Record<AttemptStatus, AttemptStatus[]> = {
  created: ["created"],
  pending: ["created", "pending"],
  processing: ["created", "pending", "processing"],
  action_required: ["created", "pending", "processing", "action_required"],
  succeeded: ["created", "pending", "processing", "action_required", "succeeded"],
  failed: ["created", "pending", "processing", "action_required", "failed"],
  canceled: ["created", "pending", "processing", "action_required", "canceled"],
  refunded: ["created", "pending", "processing", "action_required", "succeeded", "refunded"],
  quarantined: [
    "created",
    "pending",
    "processing",
    "action_required",
    "succeeded",
    "canceled",
    "quarantined",
  ],
}

export type Attempt = {
  id: string
  userId: number
  purpose: PaymentPurpose
  businessReference: string
  generation: number
  clientReferenceId: string
  amountCents: number
  status: AttemptStatus
  providerSessionId: string | null
  providerPaymentId: string | null
  providerCustomerId: string | null
  providerPaymentMethodId: string | null
  providerRedirectUrl: string | null
  amountReceivedCents: number | null
  nextActionType: string | null
  nextActionUrl: string | null
  errorCode: string | null
  errorMessage: string | null
  metadata: Record<string, string>
  mandate?: {
    status: string
    providerCustomerId: string | null
    providerPaymentMethodId: string | null
  }
  transitions: AttemptStatus[]
}

export class FlexPaymentRepository {
  readonly attempts = new Map<string, Attempt>()
  readonly events = new Map<string, { status: string; eventType: string }>()

  update(id: string, patch: Partial<Attempt>): Attempt | null {
    const attempt = this.attempts.get(id)
    if (!attempt) return null
    if (patch.status && !ALLOWED_PREVIOUS_STATUSES[patch.status].includes(attempt.status))
      return null
    const next = { ...attempt, ...patch }
    if (patch.status && patch.status !== attempt.status)
      next.transitions = [...attempt.transitions, patch.status]
    this.attempts.set(id, next)
    return next
  }

  bind(id: string, patch: Partial<Attempt>): Attempt {
    const attempt = this.attempts.get(id) as Attempt
    if (attempt.providerSessionId === null) {
      // The bind has no status guard, only "not bound yet".
      const next = { ...attempt, ...patch }
      if (patch.status && patch.status !== attempt.status) {
        next.transitions = [...attempt.transitions, patch.status]
      }
      this.attempts.set(id, next)
      return next
    }
    if (attempt.providerSessionId === patch.providerSessionId) return attempt
    throw new HttpException(
      409,
      "Flex checkout session could not be persisted. Retry the checkout.",
    )
  }

  byProviderSession(id: string) {
    return [...this.attempts.values()].find((a) => a.providerSessionId === id) ?? null
  }

  byProviderPayment(id: string) {
    return [...this.attempts.values()].find((a) => a.providerPaymentId === id) ?? null
  }
}

// --- flex-payment-orchestrator.service.ts -------------------------------------------------

export type CheckoutCommand = {
  userId: number
  purpose: PaymentPurpose
  businessReference: string
  amountCents: number
  lineItems: Array<{
    merchantProductId: string
    name: string
    unitAmountCents: number
    quantity: number
  }>
  successUrl: string
  cancelUrl: string
  setupFutureUse?: "off_session"
  metadata: Record<string, string>
  generation?: number
}

export class FlexOrchestrator {
  constructor(
    readonly api: FlexApiClient,
    readonly catalog: FlexCatalog,
    readonly repository: FlexPaymentRepository,
  ) {}

  createCheckout(command: CheckoutCommand) {
    return this.createPaymentAttempt(command, "payment")
  }

  createOffSessionCharge(
    command: CheckoutCommand & { providerCustomerId: string; providerPaymentMethodId: string },
  ) {
    return this.createPaymentAttempt(command, "off_session")
  }

  createSetupCheckout(
    command: Omit<CheckoutCommand, "amountCents" | "lineItems" | "setupFutureUse"> & {
      customer: {
        firstName: string | null
        lastName: string | null
        email: string | null
        phone: string | null
      }
      reusableCustomerId?: string
    },
  ) {
    return this.createPaymentAttempt(
      { ...command, amountCents: 0, lineItems: [], setupFutureUse: "off_session" },
      "setup",
    )
  }

  private async createPaymentAttempt(
    command: CheckoutCommand & {
      providerCustomerId?: string
      providerPaymentMethodId?: string
      customer?: {
        firstName: string | null
        lastName: string | null
        email: string | null
        phone: string | null
      }
      reusableCustomerId?: string
    },
    mode: "payment" | "off_session" | "setup",
  ) {
    const expected = command.lineItems.reduce((t, l) => t + l.unitAmountCents * l.quantity, 0)
    if (expected !== command.amountCents) {
      throw new HttpException(400, "Flex line items do not match the authoritative total")
    }
    const resolvedLineItems =
      mode === "setup" ? [] : this.catalog.resolve(command.purpose, command.lineItems)
    const metadata = {
      ...command.metadata,
      payment_provider: "flex",
      payment_purpose: command.purpose,
      business_reference: command.businessReference,
      setup_future_use: command.setupFutureUse ?? "",
      merchant_product_ids: JSON.stringify(command.lineItems.map((l) => l.merchantProductId)),
      merchant_product_names: JSON.stringify(command.lineItems.map((l) => l.name)),
    }
    const id = randomUUID()
    const created: Attempt = {
      id,
      userId: command.userId,
      purpose: command.purpose,
      businessReference: command.businessReference,
      generation: command.generation ?? 1,
      clientReferenceId: id,
      amountCents: command.amountCents,
      status: "created",
      providerSessionId: null,
      providerPaymentId: null,
      providerCustomerId: null,
      providerPaymentMethodId: null,
      providerRedirectUrl: null,
      amountReceivedCents: null,
      nextActionType: null,
      nextActionUrl: null,
      errorCode: null,
      errorMessage: null,
      metadata,
      transitions: ["created"],
    }
    this.repository.attempts.set(id, created)
    let attempt =
      this.repository.update(id, { status: "processing", errorCode: null, errorMessage: null }) ??
      created
    try {
      const customerId =
        mode === "setup"
          ? await this.resolveSetupCustomerId(attempt, command)
          : command.providerCustomerId
      const session = await this.api.createCheckoutSession(
        {
          clientReferenceId: attempt.clientReferenceId,
          mode,
          lineItems: resolvedLineItems,
          successUrl: command.successUrl,
          cancelUrl: command.cancelUrl,
          ...(command.setupFutureUse ? { setupFutureUse: command.setupFutureUse } : {}),
          ...(customerId ? { customerId } : {}),
          ...(command.providerPaymentMethodId
            ? { paymentMethodId: command.providerPaymentMethodId }
            : {}),
          metadata,
        },
        attempt.id,
      )
      attempt = await this.applyAuthoritativeSession(attempt, session)
      return { attempt, result: this.toCheckoutResult(attempt) }
    } catch (error) {
      if (error instanceof HttpException && error.message.includes("profile")) throw error
      const recovered = await this.recoverAmbiguousCreate(attempt.clientReferenceId)
      if (recovered.length === 1) {
        attempt = await this.applyAuthoritativeSession(attempt, recovered[0] as FlexCheckoutSession)
        return { attempt, result: this.toCheckoutResult(attempt) }
      }
      if (recovered.length > 1) {
        this.repository.update(attempt.id, {
          status: "quarantined",
          errorCode: "duplicate_provider_sessions",
          errorMessage: "Multiple Flex sessions were found for one payment attempt",
        })
        throw new HttpException(409, "Flex checkout requires manual reconciliation")
      }
      if (error instanceof FlexApiError && error.status !== null && error.status < 500) {
        this.repository.update(attempt.id, {
          status: "failed",
          errorCode: `flex_http_${error.status}`,
          errorMessage: error.message,
        })
      }
      throw error
    }
  }

  private async resolveSetupCustomerId(
    attempt: Attempt,
    command: {
      customer?: {
        firstName: string | null
        lastName: string | null
        email: string | null
        phone: string | null
      }
      reusableCustomerId?: string
      metadata: Record<string, string>
    },
  ) {
    if (command.reusableCustomerId) return command.reusableCustomerId
    if (!command.customer?.phone?.trim()) {
      throw new HttpException(
        400,
        "Add a phone number to your profile before switching to HSA/FSA billing",
      )
    }
    const customer = flexCreateCustomerInputSchema.safeParse(command.customer)
    if (!customer.success) {
      throw new HttpException(400, "Complete your profile before switching to HSA/FSA billing")
    }
    const checkoutNonce = command.metadata.checkoutNonce?.trim() || attempt.clientReferenceId
    const idempotencyKey = `flex-customer:${createHash("sha256").update(`${attempt.id}:${checkoutNonce}`).digest("hex")}`
    const created = await this.api.createCustomer(customer.data, idempotencyKey)
    return created.customer_id
  }

  private async recoverAmbiguousCreate(clientReferenceId: string) {
    try {
      return await this.api.findCheckoutSessionsByClientReference(clientReferenceId)
    } catch {
      return []
    }
  }

  async reconcileAttempt(attemptId: string, providerSessionId: string) {
    const attempt = this.repository.attempts.get(attemptId)
    if (!attempt) throw new HttpException(404, "Flex payment attempt not found")
    const session = await this.api.getCheckoutSession(providerSessionId)
    return this.applyAuthoritativeSession(attempt, session)
  }

  async refundAttempt(attemptId: string, amountCents?: number) {
    const attempt = this.repository.attempts.get(attemptId)
    if (!attempt) throw new HttpException(404, "Flex payment attempt not found")
    if (attempt.status === "refunded") return attempt
    if (!attempt.providerSessionId || attempt.status !== "succeeded") {
      throw new HttpException(409, "Only a succeeded Flex payment can be refunded")
    }
    const pending =
      this.repository.update(attempt.id, { errorCode: "refund_pending", errorMessage: null }) ??
      attempt
    const idempotencyKey = `flex-refund:${attempt.id}:${amountCents ?? "full"}`
    try {
      const session = await this.api.refundCheckoutSession(
        attempt.providerSessionId,
        idempotencyKey,
        amountCents,
      )
      return await this.applyAuthoritativeSession(pending, session)
    } catch (error) {
      try {
        const session = await this.api.getCheckoutSession(attempt.providerSessionId)
        const reconciled = await this.applyAuthoritativeSession(pending, session)
        if (reconciled.status === "refunded") return reconciled
      } catch {
        // logged in the app
      }
      if (error instanceof FlexApiError && error.status !== null && error.status < 500) {
        this.repository.update(pending.id, {
          status: "quarantined",
          errorCode: `flex_refund_http_${error.status}`,
          errorMessage: error.message,
        })
      }
      throw error
    }
  }

  async applyAuthoritativeSession(
    attempt: Attempt,
    session: FlexCheckoutSession,
  ): Promise<Attempt> {
    const setupIntent = await this.resolveSetupIntent(session)
    const status = resolveStatus(session, setupIntent)
    const paymentIntent = getSessionPaymentIntent(session)
    const providerPaymentId =
      getExpandableId(paymentIntent, "payment_intent_id") ?? setupIntent?.setup_intent_id ?? null
    const providerCustomerId =
      getExpandableId(setupIntent?.customer, "customer_id") ??
      getExpandableId(session.customer, "customer_id") ??
      (typeof paymentIntent === "object" && paymentIntent !== null
        ? getExpandableId(paymentIntent.customer, "customer_id")
        : null)
    const providerPaymentMethodId =
      getExpandableId(setupIntent?.payment_method, "payment_method_id") ??
      (typeof paymentIntent === "object" && paymentIntent !== null
        ? getExpandableId(paymentIntent.payment_method, "payment_method_id")
        : null)
    const amountReceivedCents =
      (session.mode === "setup" ? 0 : session.amount_received) ??
      (typeof paymentIntent === "object" && paymentIntent !== null
        ? paymentIntent.amount_received
        : null) ??
      null
    const amountMatches = session.amount_total === attempt.amountCents
    const requiresExactReceivedAmount = status === "succeeded" || status === "refunded"
    const receivedMatches =
      !requiresExactReceivedAmount || amountReceivedCents === attempt.amountCents
    const refundedMatches = status !== "refunded" || session.amount_refunded === attempt.amountCents
    const nextActionUrl = getNextActionUrl(session)
    const finalStatus: AttemptStatus =
      amountMatches && receivedMatches && refundedMatches ? status : "quarantined"
    const refundStillPending = attempt.errorCode === "refund_pending" && finalStatus === "succeeded"
    const update: Partial<Attempt> = {
      providerSessionId: session.checkout_session_id,
      providerPaymentId,
      providerCustomerId,
      providerPaymentMethodId,
      providerRedirectUrl: session.redirect_url,
      amountReceivedCents: amountReceivedCents ?? null,
      status: finalStatus,
      nextActionType: session.next_action?.type ?? null,
      nextActionUrl,
      errorCode:
        finalStatus === "quarantined"
          ? "provider_amount_mismatch"
          : refundStillPending
            ? "refund_pending"
            : null,
      errorMessage: finalStatus === "quarantined" ? `Expected ${attempt.amountCents} cents` : null,
    }
    const updated =
      attempt.providerSessionId === null
        ? this.repository.bind(attempt.id, update)
        : this.repository.update(attempt.id, update)
    if (!updated) return this.repository.attempts.get(attempt.id) as Attempt
    if (attempt.metadata.setup_future_use === "off_session") {
      const reusable = Boolean(updated.providerCustomerId && updated.providerPaymentMethodId)
      updated.mandate = {
        status:
          updated.status === "succeeded" && reusable
            ? "active"
            : updated.status === "action_required"
              ? "action_required"
              : updated.status === "refunded"
                ? "revoked"
                : "pending",
        providerCustomerId: updated.providerCustomerId,
        providerPaymentMethodId: updated.providerPaymentMethodId,
      }
    }
    return updated
  }

  private async resolveSetupIntent(session: FlexCheckoutSession) {
    if (session.mode !== "setup" || !session.setup_intent) return null
    if (typeof session.setup_intent !== "string") return session.setup_intent
    return this.api.getSetupIntent(session.setup_intent)
  }

  toCheckoutResult(attempt: Attempt) {
    if (!attempt.providerSessionId)
      throw new HttpException(409, "Flex checkout is still being initialized")
    if (!["pending", "processing", "action_required", "succeeded"].includes(attempt.status)) {
      throw new HttpException(
        409,
        attempt.errorMessage ?? `Flex checkout cannot continue from ${attempt.status}`,
      )
    }
    return {
      attemptId: attempt.id,
      providerReference: attempt.providerSessionId,
      redirectUrl: attempt.nextActionUrl ?? attempt.providerRedirectUrl ?? "",
      status:
        attempt.status === "succeeded"
          ? ("succeeded" as const)
          : attempt.status === "action_required"
            ? ("action_required" as const)
            : ("pending" as const),
      nextActionType: attempt.nextActionType ?? undefined,
      nextActionUrl: attempt.nextActionUrl ?? undefined,
    }
  }
}

/** `resolveStatus` (orchestrator `:867-906`), verbatim. */
export const resolveStatus = (
  session: FlexCheckoutSession,
  setupIntent: FlexSetupIntent | null,
): AttemptStatus => {
  if (session.mode === "setup") {
    if (session.next_action || setupIntent?.status === "requires_action") return "action_required"
    if (setupIntent?.status === "processing") return "processing"
    if (session.status === "canceled" || session.status === "expired") return "canceled"
    if (setupIntent?.status === "canceled") return "canceled"
    if (
      setupIntent &&
      ["succeeded", "complete"].includes(setupIntent.status) &&
      getExpandableId(setupIntent.customer, "customer_id") &&
      getExpandableId(setupIntent.payment_method, "payment_method_id")
    ) {
      return "succeeded"
    }
    return "pending"
  }
  if (
    session.amount_refunded !== null &&
    session.amount_refunded !== undefined &&
    session.amount_refunded > 0
  ) {
    return session.amount_refunded === session.amount_total ? "refunded" : "quarantined"
  }
  if (session.next_action) return "action_required"
  const paymentIntent = getSessionPaymentIntent(session)
  const paymentIntentStatus =
    typeof paymentIntent === "object" && paymentIntent !== null ? paymentIntent.status : null
  if (paymentIntentStatus === "requires_action") return "action_required"
  if (paymentIntentStatus === "processing") return "processing"
  if (paymentIntentStatus === "canceled") return "canceled"
  if (paymentIntentStatus === "requires_payment_method") return "failed"
  if (session.status === "paid" || session.status === "complete") return "succeeded"
  if (session.status === "canceled" || session.status === "expired") return "canceled"
  return "pending"
}

export const getNextActionUrl = (session: FlexCheckoutSession) => {
  const nextAction = session.next_action
  if (!nextAction) return null
  const detail = Reflect.get(nextAction, nextAction.type)
  if (typeof detail !== "object" || detail === null) return null
  const url = Reflect.get(detail, "url")
  return typeof url === "string" ? url : null
}

// --- flex-webhook-signature.service.ts ------------------------------------------------------

const BASE64_VALUE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

const decodeBase64 = (value: string) => {
  if (!BASE64_VALUE_PATTERN.test(value)) return null
  const hasPadding = value.includes("=")
  if ((hasPadding && value.length % 4 !== 0) || (!hasPadding && value.length % 4 === 1)) return null
  const decoded = Buffer.from(value, "base64")
  const canonicalValue = decoded.toString("base64").replace(/=+$/, "")
  return canonicalValue === value.replace(/=+$/, "") ? decoded : null
}

const decodeWebhookSecret = (webhookSecret: string) => {
  const prefix = ["fwhsec_", "whsec_"].find((candidate) => webhookSecret.startsWith(candidate))
  if (!prefix) throw new HttpException(401, "Flex webhook secret has an invalid format")
  const secretBytes = decodeBase64(webhookSecret.slice(prefix.length))
  if (!secretBytes?.length)
    throw new HttpException(401, "Flex webhook secret has an invalid format")
  return secretBytes
}

/** Throws 400 (missing fields) or 401 (bad signature, stale timestamp) like the receiver. */
export const verifyFlexSignature = (
  webhookSecret: string,
  rawBody: string,
  eventId: string,
  timestamp: string,
  signature: string,
  toleranceSeconds = 300,
  nowMs = Date.now(),
) => {
  if (!webhookSecret) throw new HttpException(401, "Flex webhook is not configured")
  if (!eventId || !timestamp || !signature || !rawBody) {
    throw new HttpException(400, "Missing Flex webhook signature fields")
  }
  const timestampSeconds = Number(timestamp)
  if (!Number.isFinite(timestampSeconds))
    throw new HttpException(400, "Invalid Flex webhook timestamp")
  if (Math.abs(nowMs / 1000 - timestampSeconds) > toleranceSeconds) {
    throw new HttpException(401, "Flex webhook timestamp is outside the tolerance window")
  }
  const secretBytes = decodeWebhookSecret(webhookSecret)
  const expectedSignature = createHmac("sha256", secretBytes)
    .update(`${eventId}.${timestamp}.${rawBody}`)
    .digest()
  const signatures = signature
    .split(" ")
    .map((candidate) => candidate.split(",").at(1))
    .filter((candidate): candidate is string => Boolean(candidate))
  const valid = signatures.some((candidate) => {
    const candidateBytes = decodeBase64(candidate)
    return (
      candidateBytes !== null &&
      candidateBytes.length === expectedSignature.length &&
      timingSafeEqual(candidateBytes, expectedSignature)
    )
  })
  if (!valid) throw new HttpException(401, "Invalid Flex webhook signature")
}

// --- flex-webhook.controller.ts + flex-webhook.service.ts -----------------------------------

const RECONCILABLE_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "checkout_session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.refunded",
  "checkout.session.expired",
  "checkout_session.expired",
  "payment_intent.succeeded",
  "refund.created",
  "refund.updated",
  "charge.refunded",
  "charge.refund.updated",
])

const getProviderSessionId = (object: Record<string, unknown>) => {
  const checkoutSession = object.checkout_session
  if (typeof checkoutSession === "string") return checkoutSession
  if (typeof checkoutSession === "object" && checkoutSession !== null) {
    const nestedId = Reflect.get(checkoutSession, "checkout_session_id")
    if (typeof nestedId === "string") return nestedId
  }
  const providerSessionId = Reflect.get(object, "checkout_session_id")
  return typeof providerSessionId === "string" ? providerSessionId : null
}

const getProviderPaymentId = (object: Record<string, unknown>) => {
  const providerPaymentId = Reflect.get(object, "payment_intent_id")
  if (typeof providerPaymentId === "string") return providerPaymentId
  const paymentIntent = Reflect.get(object, "payment_intent")
  if (typeof paymentIntent === "string") return paymentIntent
  if (typeof paymentIntent !== "object" || paymentIntent === null) return null
  const nestedId = Reflect.get(paymentIntent, "payment_intent_id")
  return typeof nestedId === "string" ? nestedId : null
}

const getProviderProductId = (object: Record<string, unknown>) => {
  const direct = Reflect.get(object, "product_id")
  if (typeof direct === "string") return direct
  const product = Reflect.get(object, "product")
  if (typeof product === "string") return product
  if (typeof product === "object" && product !== null) {
    const nested = Reflect.get(product, "product_id")
    if (typeof nested === "string") return nested
  }
  return null
}

export type WebhookOutcome =
  | { status: number; body: Record<string, unknown> }
  | { status: 400 | 401; error: string }

/** `POST /billing/webhooks/flex`: verify, parse, dedupe per event_id, reconcile. */
export class FlexWebhookReceiver {
  readonly received: { eventId: string; eventType: string; outcome: string }[] = []

  constructor(
    private readonly secret: string,
    private readonly orchestrator: FlexOrchestrator,
    private readonly toleranceSeconds = 300,
  ) {}

  async handle(headers: Headers, rawBody: string): Promise<WebhookOutcome> {
    try {
      verifyFlexSignature(
        this.secret,
        rawBody,
        headers.get("svix-id") ?? "",
        headers.get("svix-timestamp") ?? "",
        headers.get("svix-signature") ?? "",
        this.toleranceSeconds,
      )
      const body = await this.process(rawBody)
      return { status: 200, body }
    } catch (error) {
      if (error instanceof HttpException && (error.status === 400 || error.status === 401)) {
        return { status: error.status, error: error.message }
      }
      throw error
    }
  }

  private async process(rawBody: string): Promise<Record<string, unknown>> {
    let payload: unknown
    try {
      payload = JSON.parse(rawBody)
    } catch {
      throw new HttpException(400, "Invalid Flex webhook JSON")
    }
    const parsed = flexWebhookEnvelopeSchema.safeParse(payload)
    if (!parsed.success) throw new HttpException(400, "Invalid Flex webhook payload")
    const { event } = parsed.data
    const repository = this.orchestrator.repository
    const note = (outcome: string) =>
      this.received.push({ eventId: event.event_id, eventType: event.event_type, outcome })
    const existing = repository.events.get(event.event_id)
    if (existing && (existing.status === "processed" || existing.status === "ignored")) {
      note("duplicate")
      return { received: true, duplicate: true }
    }
    repository.events.set(event.event_id, { status: "received", eventType: event.event_type })
    const mark = (status: string) =>
      repository.events.set(event.event_id, { status, eventType: event.event_type })
    if (event.event_type === "product.updated") {
      const productId = getProviderProductId(event.object)
      if (!productId)
        throw new HttpException(400, "Flex product.updated event is missing a product ID")
      const result = await this.orchestrator.catalog.refreshProduct(productId)
      mark("processed")
      note("processed")
      return { received: true, catalogMappingsUpdated: result.updated }
    }
    if (!RECONCILABLE_EVENT_TYPES.has(event.event_type)) {
      mark("ignored")
      note("ignored")
      return { received: true, ignored: true }
    }
    const providerSessionId = getProviderSessionId(event.object)
    const providerPaymentId = getProviderPaymentId(event.object)
    const attempt = providerSessionId
      ? repository.byProviderSession(providerSessionId)
      : providerPaymentId
        ? repository.byProviderPayment(providerPaymentId)
        : null
    if (!attempt?.providerSessionId) {
      mark("ignored")
      note("ignored")
      return { received: true, ignored: true }
    }
    await this.orchestrator.reconcileAttempt(attempt.id, attempt.providerSessionId)
    mark("processed")
    note("processed")
    return { received: true }
  }
}

/** Browser-ish driver for the hosted page: fill the form the way codecept does, submit it. */
export const payOnHostedPage = async (
  send: Fetch,
  pageUrl: string,
  card: string,
  contact = {
    email: "qa-flex-test+mock@acme.example",
    firstName: "QA",
    lastName: "Playwright",
    phone: "5555550199",
  },
) => {
  const page = await send(new Request(pageUrl))
  const markup = await page.text()
  const form = new URLSearchParams({
    step: "card",
    email: contact.email,
    firstName: contact.firstName,
    lastName: contact.lastName,
    phone: contact.phone,
    cardNumber: card.replace(/\s/g, ""),
    expiry: "1229",
    cvc: "123",
    postalCode: "12345",
  })
  const response = await send(
    new Request(pageUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    }),
  )
  return { page: { status: page.status, markup }, response, body: await response.text() }
}
