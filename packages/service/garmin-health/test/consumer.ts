// Port of the issue's consumer (a Python/httpx provider class and a FastAPI webhook receiver):
// the same requests, headers, status interpretation and field reads, so the acceptance tests
// exercise the emulator the way the application does. Where the issue and a Garmin doc could
// differ, the issue's wire is followed.
type Fetcher = (request: Request) => Promise<Response>

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")

export const pkcePair = async (seed = "v") => {
  const verifier = base64url(
    new TextEncoder().encode(`${seed}-pkce-verifier-of-sufficient-length-0123456789abcdef`),
  )
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  )
  return { verifier, challenge: base64url(digest) }
}

/** The consent URL: `redirect_uri` is sent unencoded, and no `scope` parameter. */
export const authorizeUrl = (
  origin: string,
  input: { clientId: string; redirectUri: string; state: string; challenge: string },
) =>
  `${origin}/oauth2Confirm?response_type=code&client_id=${input.clientId}` +
  `&redirect_uri=${input.redirectUri}&state=${input.state}` +
  `&code_challenge=${input.challenge}&code_challenge_method=S256`

export type Tokens = { accessToken: string; refreshToken: string; expiresAt: number }
export type Credentials = { clientId: string; clientSecret: string }

const form = (fields: Record<string, string>) =>
  ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  }) as const

export class GarminError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`garmin ${status}`)
  }
}

export class GarminConsumer {
  tokens: Tokens | undefined
  /** Seconds the consumer waited on 429s (capped at 30 each). */
  readonly waited: number[] = []
  constructor(
    private readonly fetcher: Fetcher,
    readonly origin: string,
    private readonly credentials: Credentials,
    private readonly now: () => number = Date.now,
  ) {}

  private get tokenUrl() {
    return `${this.origin}/di-oauth2-service/oauth/token`
  }

  private store(body: Record<string, unknown>, previousRefresh = ""): Tokens {
    // expires_in is required; the old refresh token is kept when the response has none.
    if (typeof body.expires_in !== "number") throw new Error("token response without expires_in")
    this.tokens = {
      accessToken: String(body.access_token),
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : previousRefresh,
      expiresAt: this.now() + body.expires_in * 1000,
    }
    return this.tokens
  }

  async exchangeCode(input: { code: string; redirectUri: string; verifier: string }) {
    const response = await this.fetcher(
      new Request(
        this.tokenUrl,
        form({
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.verifier,
          client_id: this.credentials.clientId,
          client_secret: this.credentials.clientSecret,
        }),
      ),
    )
    const body = (await response.json()) as Record<string, unknown>
    if (!response.ok) throw new GarminError(response.status, body)
    return this.store(body)
  }

  async refresh() {
    const previous = this.tokens?.refreshToken ?? ""
    const response = await this.fetcher(
      new Request(
        this.tokenUrl,
        form({
          grant_type: "refresh_token",
          refresh_token: previous,
          client_id: this.credentials.clientId,
          client_secret: this.credentials.clientSecret,
        }),
      ),
    )
    const body = (await response.json()) as Record<string, unknown>
    if (!response.ok) throw new GarminError(response.status, body)
    return this.store(body, previous)
  }

  /** Bearer call: refresh once and retry on 401; wait (capped at 30 s) and retry once on 429. */
  async api(path: string, init: { method?: string } = {}): Promise<Response> {
    const send = () =>
      this.fetcher(
        new Request(`${this.origin}${path}`, {
          method: init.method ?? "GET",
          headers: {
            authorization: `Bearer ${this.tokens?.accessToken ?? ""}`,
            accept: "application/json",
          },
        }),
      )
    let response = await send()
    if (response.status === 401 && this.tokens?.refreshToken) {
      await this.refresh()
      response = await send()
    }
    if (response.status === 429) {
      const wait = Math.min(Number(response.headers.get("retry-after") ?? "1") || 1, 30)
      this.waited.push(wait)
      response = await send()
    }
    return response
  }

  async userId(): Promise<string | undefined> {
    const response = await this.api("/wellness-api/rest/user/id")
    // Failure is tolerated: the user id just stays unset.
    return response.ok ? ((await response.json()) as { userId: string }).userId : undefined
  }

  /** 202 is accepted, 409 means the window was already requested; anything else throws. */
  async backfill(type: string, start: number, end: number): Promise<"accepted" | "duplicate"> {
    const response = await this.api(
      `/wellness-api/rest/backfill/${type}?summaryStartTimeInSeconds=${start}&summaryEndTimeInSeconds=${end}`,
    )
    if (response.status === 202) return "accepted"
    if (response.status === 409) return "duplicate"
    throw new GarminError(response.status, await response.text())
  }

  /** Status only; an expired token answering 401 is tolerated. */
  async deregister(): Promise<number> {
    const response = await this.fetcher(
      new Request(`${this.origin}/wellness-api/rest/user/registration`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${this.tokens?.accessToken ?? ""}` },
      }),
    )
    if (!response.ok && response.status !== 401) throw new GarminError(response.status, "")
    return response.status
  }
}

type Item = Record<string, unknown>
const ACTIVITY_REQUIRED = ["activityId", "activityType", "startTimeInSeconds", "durationInSeconds"]

export type Received = {
  path: string
  accepted: { type: string; item: Item }[]
  rejected: { type: string; item: Item }[]
  pings: { userId: string; callbackURL: string; items: Item[] }[]
  deregistrations: string[]
  permissions: { userId: string; permissions: Record<string, boolean> }[]
}

/**
 * The FastAPI receiver: `garmin-client-id` must be present (401 otherwise) but its value and any
 * signature are not checked; push items are filtered, ping items fetched from their unauthenticated
 * `callbackURL`, and the answer is a 200 JSON summary.
 */
export const createReceiver = (fetcher: Fetcher, options: { status?: () => number } = {}) => {
  const received: Received[] = []
  const handle = async (request: Request): Promise<Response> => {
    if (!request.headers.get("garmin-client-id"))
      return Response.json({ detail: "Missing garmin-client-id" }, { status: 401 })
    const path = new URL(request.url).pathname.split("/").pop() ?? ""
    const body = (await request.json()) as Record<string, Item[]>
    const entry: Received = {
      path,
      accepted: [],
      rejected: [],
      pings: [],
      deregistrations: [],
      permissions: [],
    }
    if (path === "push") {
      for (const [type, items] of Object.entries(body))
        for (const item of items) {
          const valid =
            type !== "activities" || ACTIVITY_REQUIRED.every((field) => item[field] !== undefined)
          ;(valid ? entry.accepted : entry.rejected).push({ type, item })
        }
    } else if (path === "ping") {
      for (const [type, items] of Object.entries(body))
        for (const { userId, callbackURL } of items as { userId: string; callbackURL: string }[]) {
          // Unauthenticated GET of the callback; the answer is a JSON array of summaries.
          const response = await fetcher(new Request(callbackURL))
          const fetched = response.ok ? ((await response.json()) as Item[]) : []
          entry.pings.push({ userId, callbackURL, items: fetched })
          for (const item of fetched) entry.accepted.push({ type, item })
        }
    } else if (path === "deregistration") {
      const { deregistrations } = body as unknown as { deregistrations: { userId: string }[] }
      entry.deregistrations = deregistrations.map((d) => d.userId)
    } else if (path === "permissions") {
      const { userPermissionsChange } = body as unknown as {
        userPermissionsChange: { userId: string; permissions: Record<string, boolean> }[]
      }
      entry.permissions = userPermissionsChange
    }
    received.push(entry)
    const status = options.status?.() ?? 200
    return Response.json(
      { accepted: entry.accepted.length, rejected: entry.rejected.length },
      { status },
    )
  }
  return { received, handle }
}
