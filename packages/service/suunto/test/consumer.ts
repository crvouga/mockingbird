/**
 * Port of the consuming app's Suunto client (Python 3.13, httpx 0.28.1, no Suunto SDK), written
 * against issue #547: the same requests, headers, JWT claim reads, error extraction and retry rules.
 * Where the issue and its prose disagree the code here follows what the consumer sends.
 */
export type Fetcher = (request: Request) => Promise<Response>

export class SuuntoError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Suunto ${status}: ${JSON.stringify(body)}`)
  }
}

export type Tokens = {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  scope: string
}

export type ClientConfig = {
  fetcher: Fetcher
  /** Data origin (default https://cloudapi.suunto.com). */
  dataUrl: string
  /** Authorize URL (default https://cloudapi-oauth.suunto.com/oauth/authorize). */
  authorizeUrl: string
  /** Token URL (default https://cloudapi-oauth.suunto.com/oauth/token). */
  tokenUrl: string
  clientId: string
  clientSecret: string
  subscriptionKey?: string
  accessToken?: string
  refreshToken?: string
  /** Awaited between a 429 and its single retry. */
  sleep?: (ms: number) => Promise<void>
}

const DAY_MS = 86_400_000

/** The consent URL: `redirect_uri` is sent unencoded, no `scope`, no PKCE. */
export const consentUrl = (
  config: Pick<ClientConfig, "authorizeUrl" | "clientId">,
  redirectUri: string,
  state: string,
) =>
  `${config.authorizeUrl}?response_type=code&client_id=${config.clientId}&redirect_uri=${redirectUri}&state=${state}`

/** Decode a JWT payload without verifying it; a non-JWT token reads as no claims. */
export const claims = (token: string): { sub: string | null; user: string | null } => {
  const part = token.split(".")[1]
  if (token.split(".").length !== 3 || !part) return { sub: null, user: null }
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
      ),
    ) as { sub?: unknown; user?: unknown }
    return {
      sub: typeof payload.sub === "string" ? payload.sub : null,
      user: typeof payload.user === "string" ? payload.user : null,
    }
  } catch {
    return { sub: null, user: null }
  }
}

/** Consecutive `[from, to]` windows of at most `days` days over `[from, to]`. */
export const windows = (from: number, to: number, days: number): [number, number][] => {
  const out: [number, number][] = []
  for (let start = from; start < to; start += days * DAY_MS)
    out.push([start, Math.min(start + days * DAY_MS, to)])
  return out.length > 0 ? out : [[from, to]]
}

const isoSeconds = (ms: number) => new Date(ms).toISOString().slice(0, 19)

export class SuuntoClient {
  accessToken: string | undefined
  refreshToken: string | undefined
  /** Requests the 24/7 routes answered with a 4xx; the consumer logs them and skips the window. */
  readonly skipped: SuuntoError[] = []
  refreshes = 0
  constructor(readonly config: ClientConfig) {
    this.accessToken = config.accessToken
    this.refreshToken = config.refreshToken
  }

  private basic() {
    return `Basic ${btoa(`${this.config.clientId}:${this.config.clientSecret}`)}`
  }

  private async tokenRequest(form: Record<string, string>): Promise<Tokens> {
    const response = await this.config.fetcher(
      new Request(this.config.tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: this.basic(),
        },
        body: new URLSearchParams(form).toString(),
      }),
    )
    const body = (await response.json()) as Tokens
    if (!response.ok) throw new SuuntoError(response.status, body)
    if (!Number.isInteger(body.expires_in)) throw new SuuntoError(response.status, body)
    this.accessToken = body.access_token
    this.refreshToken = body.refresh_token
    return body
  }

  exchangeCode(code: string, redirectUri: string) {
    return this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    })
  }

  refresh() {
    this.refreshes++
    return this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken ?? "",
    })
  }

  private async send(path: string, query: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.accessToken ?? ""}`,
      accept: "application/json",
    }
    if (this.config.subscriptionKey)
      headers["ocp-apim-subscription-key"] = this.config.subscriptionKey
    const params = new URLSearchParams(query).toString()
    return this.config.fetcher(
      new Request(`${this.config.dataUrl}${path}${params ? `?${params}` : ""}`, { headers }),
    )
  }

  /**
   * GET a data route: wait out one 429 (Retry-After seconds), refresh once on a 401, and read a
   * top-level `code` other than 200 or a non-empty `error` in a JSON object as a failure whose
   * status is the body's `code`.
   */
  async get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    let response = await this.send(path, query)
    if (response.status === 429) {
      await (this.config.sleep ?? (async () => {}))(
        Number(response.headers.get("retry-after") ?? "1") * 1000,
      )
      response = await this.send(path, query)
    }
    if (response.status === 401 && this.refreshToken) {
      await this.refresh()
      response = await this.send(path, query)
    }
    const text = await response.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {}
    if (!response.ok) throw new SuuntoError(response.status, body)
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
      const record = body as { code?: unknown; error?: unknown }
      if (typeof record.code === "number" && record.code !== 200)
        throw new SuuntoError(record.code, body)
      if (record.error) throw new SuuntoError(response.status, body)
    }
    return body
  }

  /** The scheduled sync: one request, no paging loop. `since` is epoch seconds. */
  async workouts(since = 0): Promise<Record<string, unknown>[]> {
    const body = (await this.get("/v3/workouts/", {
      since: String(since),
      limit: "100",
      offset: "0",
      "filter-by-modification-time": "true",
    })) as { payload: Record<string, unknown>[] }
    return body.payload
  }

  /** The on-demand route pages with `offset` until a short page. */
  async allWorkouts(since = 0, limit = 100): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = []
    for (let offset = 0; ; offset += limit) {
      const body = (await this.get("/v3/workouts/", {
        since: String(since),
        limit: String(limit),
        offset: String(offset),
        "filter-by-modification-time": "true",
      })) as { payload: Record<string, unknown>[] }
      out.push(...body.payload)
      if (body.payload.length < limit) return out
    }
  }

  workout(workoutKey: string) {
    return this.get(`/v3/workouts/${workoutKey}`)
  }

  /** 24/7 windows: a 4xx is logged into `skipped` and the window is dropped. */
  private async chunked<T>(
    path: string,
    query: (from: number, to: number) => Record<string, string>,
    ranges: [number, number][],
  ): Promise<T[]> {
    const out: T[] = []
    for (const [from, to] of ranges) {
      try {
        out.push(...((await this.get(path, query(from, to))) as T[]))
      } catch (error) {
        if (error instanceof SuuntoError && error.status >= 400 && error.status < 500)
          this.skipped.push(error)
        else throw error
      }
    }
    return out
  }

  sleep(from: number, to: number, days = 20) {
    return this.chunked<{ timestamp: number; entryData: Record<string, unknown> }>(
      "/247samples/sleep",
      (a, b) => ({ from: String(a), to: String(b) }),
      windows(from, to, days),
    )
  }

  activity(from: number, to: number, days = 20) {
    return this.chunked<{ timestamp: number; entryData: Record<string, unknown> }>(
      "/247samples/activity",
      (a, b) => ({ from: String(a), to: String(b) }),
      windows(from, to, days),
    )
  }

  dailyStatistics(from: number, to: number, days = 14) {
    return this.chunked<{
      Name: string
      Aggregation: string
      Sources: { Name: string; Samples: { Value: number; TimeISO8601: string }[] }[]
    }>(
      "/247/daily-activity-statistics",
      (a, b) => ({ startdate: isoSeconds(a), enddate: isoSeconds(b) }),
      windows(from, to, days),
    )
  }
}
