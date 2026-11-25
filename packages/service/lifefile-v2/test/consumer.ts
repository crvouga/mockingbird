export const TOKEN_EXPIRY_SKEW_MS = 60_000
export const TOKEN_IDLE_TTL_MS = 60 * 60_000
export const TOKEN_IDLE_REUSE_MS = TOKEN_IDLE_TTL_MS - 5 * 60_000
export const TOKEN_AUTH_FAILURE_HOLD_MS = 30_000
const FALLBACK_EXPIRES_IN_S = TOKEN_IDLE_TTL_MS / 1_000

export type FailureCertainty = "definite" | "unknown"

export type FailureCategory =
  | "auth"
  | "forbidden"
  | "validation"
  | "not_found"
  | "rate_limited"
  | "rejected"
  | "timeout"
  | "server_error"
  | "network"

export type LifefileFailure = {
  certainty: FailureCertainty
  category: FailureCategory
  requestSent: boolean
  fields: string[]
  httpStatus?: number
  vendorCode?: string
  vendorMessage?: string
  retryAfterMs?: number
}

export class LifefileError extends Error {
  constructor(readonly failure: LifefileFailure) {
    super(
      `LifeFile ${failure.category}${failure.httpStatus ? ` (HTTP ${failure.httpStatus})` : ""}`,
    )
    this.name = "LifefileError"
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const stringField = (record: Record<string, unknown> | undefined, key: string) => {
  const value = record?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

const definiteCategory = (status: number, oauthError: string | undefined): FailureCategory => {
  if (status === 401) return "auth"
  if (oauthError !== undefined && (status === 400 || status === 422)) return "auth"
  if (status === 403) return "forbidden"
  if (status === 404) return "not_found"
  if (status === 422) return "validation"
  if (status === 429) return "rate_limited"
  return "rejected"
}

export const classifyResponse = (
  status: number,
  body: unknown,
  retryAfter?: string | null,
): LifefileFailure | null => {
  if (status >= 200 && status < 300) return null
  const record = asRecord(body)
  const oauthError = stringField(record, "error")
  const vendorMessage = stringField(record, "message") ?? stringField(record, "error_description")
  const base = {
    requestSent: true,
    httpStatus: status,
    ...(oauthError === undefined ? {} : { vendorCode: oauthError }),
    ...(vendorMessage === undefined ? {} : { vendorMessage }),
  }
  if (status >= 500 || status < 200 || (status >= 300 && status < 400)) {
    return { ...base, certainty: "unknown", category: "server_error", fields: [] }
  }
  const category = definiteCategory(status, oauthError)
  const data = asRecord(record?.data)
  const retryAfterMs =
    status === 429 && retryAfter && /^\d+$/.test(retryAfter.trim())
      ? Number(retryAfter.trim()) * 1_000
      : undefined
  return {
    ...base,
    certainty: "definite",
    category,
    fields: category === "validation" && data ? Object.keys(data).sort() : [],
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  }
}

export const classifyError = (error: unknown): LifefileFailure => {
  if (error instanceof LifefileError) return error.failure
  const name = error instanceof Error ? error.name : undefined
  if (name === "TimeoutError" || name === "AbortError") {
    return { certainty: "unknown", category: "timeout", requestSent: true, fields: [] }
  }
  return { certainty: "unknown", category: "network", requestSent: true, fields: [] }
}

export type ConsumerConfig = {
  apiUrl: string
  tokenUrl: string
  clientId: string
  clientSecret: string
  vendorId: string
}

type CachedToken = { value: string; expiresAtMs: number; lastUsedAtMs: number }

export class TokenService {
  private cached: CachedToken | null = null
  private pending: Promise<string> | null = null
  private held: { failure: LifefileFailure; untilMs: number } | null = null
  tokenRequests = 0

  constructor(
    private readonly config: ConsumerConfig,
    private readonly fetch: (request: Request) => Promise<Response>,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccessToken(): Promise<string> {
    const nowMs = this.now()
    const cached = this.cached
    if (
      cached !== null &&
      nowMs < cached.expiresAtMs &&
      nowMs - cached.lastUsedAtMs < TOKEN_IDLE_REUSE_MS
    ) {
      cached.lastUsedAtMs = nowMs
      return cached.value
    }
    this.cached = null
    if (this.held !== null) {
      if (nowMs < this.held.untilMs) throw new LifefileError(this.held.failure)
      this.held = null
    }
    if (this.pending === null) {
      this.pending = this.requestToken().finally(() => {
        this.pending = null
      })
    }
    return this.pending
  }

  invalidate(refused: string): void {
    if (this.cached?.value === refused) this.cached = null
  }

  private async requestToken(): Promise<string> {
    this.tokenRequests++
    const fail = (raw: LifefileFailure): never => {
      const failure =
        raw.certainty === "definite" && raw.category !== "rate_limited"
          ? { ...raw, category: "auth" as const }
          : raw
      if (failure.certainty === "definite" && failure.category === "auth") {
        this.held = { failure, untilMs: this.now() + TOKEN_AUTH_FAILURE_HOLD_MS }
      }
      throw new LifefileError(failure)
    }
    let response: Response
    try {
      response = await this.fetch(
        new Request(this.config.tokenUrl, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Vendor-ID": this.config.vendorId,
          },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
          }).toString(),
        }),
      )
    } catch (error) {
      return fail(classifyError(error))
    }
    const body = (await response.json().catch(() => undefined)) as unknown
    const failure = classifyResponse(response.status, body, response.headers.get("retry-after"))
    if (failure !== null) return fail(failure)
    const record = asRecord(body) ?? {}
    const token = record.access_token
    if (typeof token !== "string" || token.length === 0) {
      return fail({
        certainty: "definite",
        category: "auth",
        requestSent: true,
        fields: [],
        httpStatus: response.status,
        vendorCode: "missing_access_token",
      })
    }
    const raw = record.expires_in
    const expiresInS =
      typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : FALLBACK_EXPIRES_IN_S
    const issuedAt = this.now()
    this.cached = {
      value: token,
      expiresAtMs: issuedAt + expiresInS * 1_000 - TOKEN_EXPIRY_SKEW_MS,
      lastUsedAtMs: issuedAt,
    }
    return token
  }
}

export type Envelope<T> = { type: string; message: string; data: T }

export type Result<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; failure: LifefileFailure }

export class LifefileClient {
  retries = 0

  constructor(
    readonly config: ConsumerConfig,
    readonly tokens: TokenService,
    private readonly fetch: (request: Request) => Promise<Response>,
  ) {}

  private async attempt(method: string, path: string, body: unknown, token: string) {
    const headers = new Headers({
      Authorization: `Bearer ${token}`,
      "X-Vendor-ID": this.config.vendorId,
      Accept: "application/json",
    })
    if (body !== undefined) headers.set("Content-Type", "application/json")
    return this.fetch(
      new Request(`${this.config.apiUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
    try {
      const first = await this.tokens.getAccessToken()
      let response = await this.attempt(method, path, body, first)
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined)
        this.tokens.invalidate(first)
        this.retries++
        response = await this.attempt(method, path, body, await this.tokens.getAccessToken())
      }
      const parsed = (await response.json().catch(() => undefined)) as Envelope<T> | undefined
      const failure = classifyResponse(response.status, parsed, response.headers.get("retry-after"))
      if (failure !== null) return { ok: false, failure }
      return { ok: true, status: response.status, data: (parsed as Envelope<T>).data }
    } catch (error) {
      return { ok: false, failure: classifyError(error) }
    }
  }

  createOrder(body: unknown) {
    return this.call<{ orderId: number }>("POST", "/orders", body)
  }

  order(orderId: number) {
    return this.call<Record<string, unknown>>("GET", `/orders/${orderId}`)
  }

  status(orderId: number) {
    return this.call<{ id: string | null; label: string | null }>(
      "GET",
      `/orders/${orderId}/status`,
    )
  }

  setStatus(orderId: number, status: string) {
    return this.call<Record<string, unknown>>("PUT", `/orders/${orderId}/status`, { status })
  }

  shipping(orderId: number) {
    return this.call<Record<string, unknown>>("GET", `/orders/${orderId}/shipping`)
  }

  setShipping(orderId: number, shipping: Record<string, unknown>) {
    return this.call<null>("PUT", `/orders/${orderId}/shipping`, { shipping })
  }

  findByRxUuid(uuid: string) {
    return this.call<{
      data: { id: number; general: { statusId: string } }[]
      total: number
      perPage: number
      currentPage: number
      lastPage: number
    }>("GET", `/orders?${new URLSearchParams({ "filter[rx][uuid]": uuid })}`)
  }

  statuses(page = 1, perPage = 50) {
    return this.call<{ data: { id: string; label: string }[]; total: number; lastPage: number }>(
      "GET",
      `/statuses?perPage=${perPage}&page=${page}`,
    )
  }

  async allStatuses() {
    const out: { id: string; label: string }[] = []
    for (let page = 1; ; page++) {
      const result = await this.statuses(page)
      if (!result.ok) return result
      out.push(...result.data.data)
      if (page >= result.data.lastPage) return { ok: true as const, status: 200, data: out }
    }
  }

  async cancel(orderId: number): Promise<{ landed: string | null; attempts: number }> {
    let attempts = 0
    for (;;) {
      attempts++
      const write = await this.setStatus(orderId, "del")
      if (!write.ok) return { landed: null, attempts }
      const read = await this.status(orderId)
      const landed = read.ok ? read.data.id : null
      if (landed === "del" || attempts >= 2) return { landed, attempts }
    }
  }
}

export const consumer = (
  base: string,
  fetch: (request: Request) => Promise<Response>,
  options: { clientId?: string; clientSecret?: string; vendorId?: string; now?: () => number } = {},
) => {
  const config: ConsumerConfig = {
    apiUrl: `${base}/api/v2`,
    tokenUrl: `${base}/api/v2/auth/token`,
    clientId: options.clientId ?? "lifefile-client",
    clientSecret: options.clientSecret ?? "lifefile-secret",
    vendorId: options.vendorId ?? "10001",
  }
  const tokens = new TokenService(config, fetch, options.now)
  return new LifefileClient(config, tokens, fetch)
}

export const orderBody = (
  overrides: {
    uuid?: string
    messageId?: number | string
    referenceId?: string
    locationId?: number
    practiceId?: number
    lastName?: string
    addressLine1?: string
    scheduleCode?: string | null
    rxs?: Record<string, unknown>[]
  } = {},
) => {
  const rx: Record<string, unknown> = {
    rxType: "new",
    drugName: "Synthetic Compound",
    drugStrength: "2.5mg/mL",
    drugForm: "injection",
    quantity: "6",
    quantityUnits: "mL",
    directions: "Synthetic test - do not fill",
    refills: 0,
    daysSupply: 30,
    dateWritten: "2026-11-24",
    scheduleCode: "O",
    clinicalDifferenceStatement: "Synthetic test",
    uuid: overrides.uuid ?? "f120f5b8-09fd-4b7d-a01b-08c4ec85bc25",
  }
  if (overrides.scheduleCode === null) delete rx.scheduleCode
  else if (overrides.scheduleCode !== undefined) rx.scheduleCode = overrides.scheduleCode
  return {
    message: { id: overrides.messageId ?? 1356623387, sentTime: "2026-11-24 22:57:53" },
    order: {
      general: {
        memo: "SYNTHETIC TEST - not a real patient",
        referenceId: overrides.referenceId ?? "ref-0001",
      },
      location: { id: overrides.locationId ?? 100001 },
      prescriber: {
        npi: "1234567893",
        licenseState: "TX",
        licenseNumber: "P12345",
        lastName: "Prober",
        firstName: "Pat",
        address1: "100 Test Ave",
        city: "Austin",
        state: "TX",
        zip: "78701",
        phone: "(512) 555-0100",
        email: "prescriber@example.com",
      },
      practice: { id: overrides.practiceId ?? 900001 },
      patient: {
        lastName: overrides.lastName ?? "Synthetic",
        firstName: "Probe",
        gender: "u",
        dateOfBirth: "1990-01-01",
        address1: "200 Fake St",
        city: "Austin",
        state: "TX",
        zip: "78701",
        country: "US",
        phoneHome: "(512) 555-0111",
        phoneMobile: "(512) 555-0111",
        email: "patient@example.com",
      },
      shipping: {
        recipientType: "patient",
        recipientLastName: "Synthetic",
        recipientFirstName: "Probe",
        recipientPhone: "(512) 555-0111",
        recipientEmail: "patient@example.com",
        addressLine1: overrides.addressLine1 ?? "200 Fake St",
        city: "Austin",
        state: "TX",
        zipCode: "78701",
        country: "US",
      },
      billing: { payorType: "doc" },
      rxs: overrides.rxs ?? [rx],
    },
  }
}
