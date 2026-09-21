// Seam: the Fastify logger type.
type FastifyBaseLogger = { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }

// Seam: the EMR backend uses zod 4 (`zod`); here zod 4 comes from zod@3.25's `zod/v4` entry.
import { z } from "zod/v4"

const OAUTH_TOKEN_PATH = "api/oauth/token"
const OAUTH_REVOKE_PATH = "api/oauth/revoke"
const CLINIC_PATH = "api/clinic"
const SESSION_GRANT_PATH = "api/clinic/embeddable/session_grants"
const LAB_ORDERS_PATH = "api/clinic/labs/orders"
const LAB_ORDER_EVENTS_PATH = "api/events/lab_orders"
const EVENTS_PATH = "api/events"
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_PAGE_SIZE = 100
const MAX_LAB_ORDER_PAGES = 100
const FIRST_PAGE = 1
const REQUEST_ID_HEADER = "x-request-id"
const JSON_CONTENT_TYPE = "application/json"

const resourceOwnerSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["Practitioner", "Staff"]),
  clinic_id: z.string().min(1).optional(),
})

const oauthTokenResponseSchema = z.object({
  oauth: z.object({
    access_token: z.string().min(1),
    token_type: z.literal("Bearer"),
    expires_in: z.number().int().positive(),
    refresh_token: z.string().min(1),
    scope: z.string(),
    created_at: z.iso.datetime(),
    resource_owner: resourceOwnerSchema,
  }),
})

const clinicResponseSchema = z.object({
  clinic: z.object({
    id: z.string().min(1),
  }),
})

const sessionGrantResponseSchema = z.object({
  secret_token: z.string().min(1),
})

const labOrderSchema = z
  .object({
    id: z.string().min(1),
    state: z.string().min(1),
    treatment_plan_id: z.string().min(1).nullable().optional(),
  })
  .loose()

const labOrderResponseSchema = z.object({
  order: labOrderSchema,
})

const aggregatedResultSchema = z
  .object({
    id: z.string().min(1).optional(),
    artifact_id: z.string().min(1).optional(),
    pdf_url: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
  })
  .loose()

const perResultSchema = z
  .object({
    id: z.string().min(1).optional(),
    pdf_url: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
  })
  .loose()

const orderedTestSchema = z
  .object({
    id: z.string().min(1).optional(),
    lab_test_id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    lab_type: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
  })
  .loose()

const fullLabOrderSchema = z
  .object({
    id: z.string().min(1),
    state: z.string().min(1),
    treatment_plan_id: z.string().min(1).nullable().optional(),
    name: z.string().min(1).optional(),
    display_name: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    collection_method: z.string().min(1).optional(),
    collection_type: z.string().min(1).optional(),
    sample_type: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
    tests: z.array(orderedTestSchema).optional(),
    line_items: z.array(orderedTestSchema).optional(),
    results: z.array(perResultSchema).optional(),
    lab_results: z.array(perResultSchema).optional(),
    latest_aggregated_result: aggregatedResultSchema.nullable().optional(),
    aggregated_result: aggregatedResultSchema.nullable().optional(),
  })
  .loose()

const fullLabOrderResponseSchema = z.object({
  order: fullLabOrderSchema,
})

const paginationSchema = z
  .object({
    next_page: z.number().int().positive().nullable().optional(),
  })
  .loose()

const labOrdersResponseSchema = z.object({
  orders: z.array(labOrderSchema),
  meta: paginationSchema.optional(),
})

const labOrderEventSummarySchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("lab_order.updated"),
    clinic_id: z.string().min(1).optional(),
  })
  .loose()

const labOrderEventsResponseSchema = z.object({
  events: z.array(labOrderEventSummarySchema),
  meta: paginationSchema.optional(),
})

const eventResponseSchema = z
  .object({
    event: z
      .object({
        id: z.string().min(1),
        type: z.string().min(1),
        data: z.record(z.string(), z.unknown()).default({}),
      })
      .loose(),
  })
  .loose()

const errorPayloadSchema = z.object({
  error: z
    .union([
      z.string(),
      z.object({
        code: z.string().optional(),
      }),
    ])
    .optional(),
  errors: z
    .array(
      z.object({
        code: z.string().optional(),
      }),
    )
    .optional(),
})

export type FullscriptOAuthToken = {
  accessToken: string
  refreshToken: string
  expiresIn: number
  createdAt: string
  scope: string
  resourceOwner: {
    id: string
    type: "Practitioner" | "Staff"
    clinicId?: string
  }
}

export type FullscriptClinic = {
  id: string
}

export type FullscriptSessionGrant = {
  secretToken: string
}

export type FullscriptLabOrder = {
  id: string
  state: string
  treatmentPlanId: string | null
}

export type FullscriptAggregatedResultRef = {
  artifactId: string
  pdfUrl: string
}

export type FullscriptResultPdf = {
  resultId: string
  pdfUrl: string
}

export type FullscriptOrderedTest = {
  labTestId: string
  testName: string
}

export type FullscriptFullLabOrder = {
  id: string
  state: string
  treatmentPlanId: string | null
  testName: string | null
  collectionMethod: string | null
  tests: FullscriptOrderedTest[]
  latestAggregatedResult: FullscriptAggregatedResultRef | null
  results: FullscriptResultPdf[]
}

export type FullscriptLabOrderEventSummary = {
  id: string
  type: "lab_order.updated"
  clinicId: string | null
}

export type FullscriptLabOrderEventPage = {
  events: FullscriptLabOrderEventSummary[]
  nextPage: number | null
}

export type FullscriptApi = {
  exchangeAuthorizationCode: (code: string) => Promise<FullscriptOAuthToken>
  refreshAccessToken: (refreshToken: string) => Promise<FullscriptOAuthToken>
  revokeToken: (accessToken: string) => Promise<void>
  getClinic: (accessToken: string) => Promise<FullscriptClinic>
  createSessionGrant: (accessToken: string) => Promise<FullscriptSessionGrant>
  getLabOrder: (accessToken: string, orderId: string) => Promise<FullscriptLabOrder>
  getLabOrderDetail: (accessToken: string, orderId: string) => Promise<FullscriptFullLabOrder>
  listLabOrders: (accessToken: string, patientId: string) => Promise<FullscriptLabOrder[]>
  listLabOrderEvents: (accessToken: string, page: number) => Promise<FullscriptLabOrderEventPage>
  getEvent: (accessToken: string, eventId: string) => Promise<unknown>
}

type FullscriptApiClientOptions = {
  apiUrl: string
  clientId: string
  clientSecret: string
  redirectUri: string
  logger: Pick<FastifyBaseLogger, "info" | "warn">
  fetchImplementation?: typeof fetch
  timeoutMs?: number
}

type RequestOptions = {
  operation: string
  method: "GET" | "POST"
  path: string
  body?: Record<string, string>
  accessToken?: string
  query?: Record<string, string | number>
}

export class FullscriptApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly requestId?: string

  constructor(status: number, code?: string, requestId?: string) {
    super("Fullscript request failed")
    this.name = "FullscriptApiError"
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

export class FullscriptApiClient implements FullscriptApi {
  private readonly apiUrl: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly redirectUri: string
  private readonly logger: Pick<FastifyBaseLogger, "info" | "warn">
  private readonly fetchImplementation: typeof fetch
  private readonly timeoutMs: number

  constructor(options: FullscriptApiClientOptions) {
    this.apiUrl = ensureTrailingSlash(options.apiUrl)
    this.clientId = options.clientId
    this.clientSecret = options.clientSecret
    this.redirectUri = options.redirectUri
    this.logger = options.logger
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async exchangeAuthorizationCode(code: string) {
    const payload = await this.requestJson({
      operation: "oauth_token_exchange",
      method: "POST",
      path: OAUTH_TOKEN_PATH,
      body: {
        grant_type: "authorization_code",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: this.redirectUri,
      },
    })

    return parseOAuthToken(payload)
  }

  async refreshAccessToken(refreshToken: string) {
    const payload = await this.requestJson({
      operation: "oauth_token_refresh",
      method: "POST",
      path: OAUTH_TOKEN_PATH,
      body: {
        grant_type: "refresh_token",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
        redirect_uri: this.redirectUri,
      },
    })

    return parseOAuthToken(payload)
  }

  async revokeToken(accessToken: string) {
    await this.requestJson({
      operation: "oauth_token_revoke",
      method: "POST",
      path: OAUTH_REVOKE_PATH,
      body: {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        token: accessToken,
      },
    })
  }

  async getClinic(accessToken: string) {
    const payload = await this.requestJson({
      operation: "clinic_retrieve",
      method: "GET",
      path: CLINIC_PATH,
      accessToken,
    })
    const parsed = clinicResponseSchema.safeParse(payload)
    if (!parsed.success) {
      throw new Error("Fullscript clinic response was invalid")
    }
    return { id: parsed.data.clinic.id }
  }

  async createSessionGrant(accessToken: string) {
    const payload = await this.requestJson({
      operation: "session_grant_create",
      method: "POST",
      path: SESSION_GRANT_PATH,
      accessToken,
    })
    const parsed = sessionGrantResponseSchema.safeParse(payload)
    if (!parsed.success) {
      throw new Error("Fullscript session grant response was invalid")
    }
    return { secretToken: parsed.data.secret_token }
  }

  async getLabOrder(accessToken: string, orderId: string) {
    const payload = await this.requestJson({
      operation: "lab_order_retrieve",
      method: "GET",
      path: `${LAB_ORDERS_PATH}/${encodeURIComponent(orderId)}`,
      accessToken,
    })
    const parsed = labOrderResponseSchema.safeParse(payload)
    if (!parsed.success) {
      throw new Error("Fullscript lab order response was invalid")
    }
    return serializeLabOrder(parsed.data.order)
  }

  async getLabOrderDetail(accessToken: string, orderId: string) {
    const payload = await this.requestJson({
      operation: "lab_order_detail_retrieve",
      method: "GET",
      path: `${LAB_ORDERS_PATH}/${encodeURIComponent(orderId)}`,
      accessToken,
    })
    const parsed = fullLabOrderResponseSchema.safeParse(payload)
    if (!parsed.success) {
      throw new Error("Fullscript lab order detail response was invalid")
    }
    return serializeFullLabOrder(parsed.data.order)
  }

  async listLabOrders(accessToken: string, patientId: string) {
    const orders: FullscriptLabOrder[] = []
    let page = FIRST_PAGE
    for (let pageCount = 0; pageCount < MAX_LAB_ORDER_PAGES; pageCount += 1) {
      const payload = await this.requestJson({
        operation: "lab_orders_list",
        method: "GET",
        path: LAB_ORDERS_PATH,
        accessToken,
        query: {
          patient_id: patientId,
          "page[number]": page,
          "page[size]": MAX_PAGE_SIZE,
        },
      })
      const parsed = labOrdersResponseSchema.safeParse(payload)
      if (!parsed.success) {
        throw new Error("Fullscript lab orders response was invalid")
      }
      orders.push(...parsed.data.orders.map(serializeLabOrder))
      const nextPage = parsed.data.meta?.next_page
      if (!nextPage) {
        return orders
      }
      page = nextPage
    }
    throw new Error("Fullscript lab orders response exceeded the page limit")
  }

  async listLabOrderEvents(accessToken: string, page: number) {
    const payload = await this.requestJson({
      operation: "lab_order_events_list",
      method: "GET",
      path: LAB_ORDER_EVENTS_PATH,
      accessToken,
      query: {
        order_by: "DESC",
        "page[number]": page,
        "page[size]": MAX_PAGE_SIZE,
      },
    })
    const parsed = labOrderEventsResponseSchema.safeParse(payload)
    if (!parsed.success) {
      throw new Error("Fullscript lab order events response was invalid")
    }
    return {
      events: parsed.data.events.map((event) => ({
        id: event.id,
        type: event.type,
        clinicId: event.clinic_id ?? null,
      })),
      nextPage: parsed.data.meta?.next_page ?? null,
    }
  }

  async getEvent(accessToken: string, eventId: string) {
    const payload = await this.requestJson({
      operation: "event_retrieve",
      method: "GET",
      path: `${EVENTS_PATH}/${encodeURIComponent(eventId)}`,
      accessToken,
    })
    const parsed = eventResponseSchema.safeParse(payload)
    if (!parsed.success) {
      throw new Error("Fullscript event response was invalid")
    }
    return parsed.data
  }

  private async requestJson(options: RequestOptions) {
    let response: Response
    try {
      const headers = new Headers({ Accept: JSON_CONTENT_TYPE })
      if (options.method === "POST") {
        headers.set("Content-Type", JSON_CONTENT_TYPE)
      }
      if (options.accessToken) {
        headers.set("Authorization", `Bearer ${options.accessToken}`)
      }

      const requestUrl = new URL(options.path, this.apiUrl)
      for (const [name, value] of Object.entries(options.query ?? {})) {
        requestUrl.searchParams.set(name, String(value))
      }
      response = await this.fetchImplementation(requestUrl, {
        method: options.method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch {
      this.logger.warn({ operation: options.operation }, "Fullscript request did not complete")
      throw new Error("Fullscript request did not complete")
    }

    const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined
    this.logger.info(
      {
        operation: options.operation,
        status: response.status,
        fullscriptRequestId: requestId,
      },
      "Fullscript request completed",
    )

    const payload = await parseResponseBody(response)
    if (!response.ok) {
      const code = extractErrorCode(payload)
      throw new FullscriptApiError(response.status, code, requestId)
    }

    return payload
  }
}

function serializeLabOrder(order: z.infer<typeof labOrderSchema>): FullscriptLabOrder {
  return {
    id: order.id,
    state: order.state,
    treatmentPlanId: order.treatment_plan_id ?? null,
  }
}

function serializeFullLabOrder(order: z.infer<typeof fullLabOrderSchema>): FullscriptFullLabOrder {
  const testSource = order.tests ?? order.line_items ?? []
  const tests: FullscriptOrderedTest[] = []
  for (const test of testSource) {
    const labTestId = test.id ?? test.lab_test_id
    const testName = test.name ?? test.lab_type ?? test.type
    if (labTestId && testName) {
      tests.push({ labTestId, testName })
    }
  }

  const aggregate = order.latest_aggregated_result ?? order.aggregated_result ?? null
  const latestAggregatedResult = aggregate?.pdf_url
    ? {
        artifactId: aggregate.artifact_id ?? aggregate.id ?? "aggregate",
        pdfUrl: aggregate.pdf_url,
      }
    : null

  const resultSource = order.results ?? order.lab_results ?? []
  const results: FullscriptResultPdf[] = []
  for (const result of resultSource) {
    if (result.id && result.pdf_url) {
      results.push({ resultId: result.id, pdfUrl: result.pdf_url })
    }
  }

  return {
    id: order.id,
    state: order.state,
    treatmentPlanId: order.treatment_plan_id ?? null,
    testName: order.name ?? order.display_name ?? order.title ?? null,
    collectionMethod:
      order.collection_method ?? order.collection_type ?? order.sample_type ?? order.type ?? null,
    tests,
    latestAggregatedResult,
    results,
  }
}

function parseOAuthToken(payload: unknown) {
  const parsed = oauthTokenResponseSchema.safeParse(payload)
  if (!parsed.success) {
    throw new Error("Fullscript OAuth response was invalid")
  }

  const oauth = parsed.data.oauth
  return {
    accessToken: oauth.access_token,
    refreshToken: oauth.refresh_token,
    expiresIn: oauth.expires_in,
    createdAt: oauth.created_at,
    scope: oauth.scope,
    resourceOwner: {
      id: oauth.resource_owner.id,
      type: oauth.resource_owner.type,
      ...(oauth.resource_owner.clinic_id ? { clinicId: oauth.resource_owner.clinic_id } : {}),
    },
  }
}

async function parseResponseBody(response: Response) {
  const responseText = await response.text()
  if (!responseText) {
    return {}
  }

  try {
    return JSON.parse(responseText) as unknown
  } catch {
    if (response.ok) {
      throw new Error("Fullscript response was not valid JSON")
    }
    return {}
  }
}

function extractErrorCode(payload: unknown) {
  const parsed = errorPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    return undefined
  }
  if (typeof parsed.data.error === "string") {
    return parsed.data.error
  }
  return parsed.data.error?.code ?? parsed.data.errors?.find((error) => error.code)?.code
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`
}
