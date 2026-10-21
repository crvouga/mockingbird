// HTTP port of the issue's Python 3.13 / httpx 0.28.1 Fitbit client: form-encoded token requests with
// Basic client auth, query-string data reads, an unencoded redirect_uri, one sync window per day.
export type Fetcher = (request: Request) => Promise<Response>
export type Config = { base: string; clientId: string; clientSecret: string }
export const SCOPE = "activity heartrate profile settings sleep"

const basic = (config: Config) => `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`
const bearer = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/json" })
const form = (values: Record<string, string>) => new URLSearchParams(values)

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
export const pkce = async (verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))) => ({
  verifier,
  challenge: base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  ),
})

/** The consent URL: redirect_uri is sent unencoded and the scope has percent-encoded spaces. */
export const authorizeUrl = (
  config: Config,
  input: { redirectUri: string; state: string; challenge: string; scope?: string },
) =>
  `${config.base}/oauth2/authorize?response_type=code&client_id=${config.clientId}` +
  `&redirect_uri=${input.redirectUri}&state=${input.state}` +
  `&scope=${(input.scope ?? SCOPE).replaceAll(" ", "%20")}` +
  `&code_challenge=${input.challenge}&code_challenge_method=S256`

/** The browser step: follow the consent page to the redirect and read `code`/`state`/`error`. */
export const consent = async (fetcher: Fetcher, url: string) => {
  const response = await fetcher(new Request(url, { redirect: "manual" }))
  const location = response.headers.get("location")
  if (response.status !== 302 || !location) return { status: response.status, redirected: false }
  const target = new URL(location)
  return {
    status: response.status,
    redirected: true,
    origin: target.origin + target.pathname,
    code: target.searchParams.get("code") ?? undefined,
    state: target.searchParams.get("state") ?? undefined,
    error: target.searchParams.get("error") ?? undefined,
    errorDescription: target.searchParams.get("error_description") ?? undefined,
  }
}

/** The consumer reads a top-level error string if there is one; it otherwise keeps the status. */
export const tokenError = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null) return undefined
  for (const key of ["error", "error_code", "errorCode", "code"]) {
    const value = (body as Record<string, unknown>)[key]
    if (typeof value === "string") return value
  }
  return undefined
}

const token = async (fetcher: Fetcher, config: Config, values: Record<string, string>) => {
  const response = await fetcher(
    new Request(`${config.base}/oauth2/token`, {
      method: "POST",
      headers: { authorization: basic(config) },
      body: form(values),
    }),
  )
  const body = (await response.json()) as Record<string, unknown>
  return { status: response.status, body, error: tokenError(body) }
}
export const exchangeCode = (
  fetcher: Fetcher,
  config: Config,
  input: { code: string; redirectUri: string; verifier: string },
) =>
  token(fetcher, config, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  })
export const refresh = (fetcher: Fetcher, config: Config, refreshToken: string) =>
  token(fetcher, config, { grant_type: "refresh_token", refresh_token: refreshToken })
export const revoke = (fetcher: Fetcher, config: Config, accessToken: string) =>
  fetcher(
    new Request(`${config.base}/oauth2/revoke`, {
      method: "POST",
      headers: { authorization: basic(config) },
      body: form({ token: accessToken }),
    }),
  )

export const get = (fetcher: Fetcher, config: Config, accessToken: string, path: string) =>
  fetcher(new Request(`${config.base}${path}`, { headers: bearer(accessToken) }))

/** One retry after a 429, waiting `Retry-After` seconds; a second 429 is surfaced as is. */
export const getRetrying = async (
  fetcher: Fetcher,
  config: Config,
  accessToken: string,
  path: string,
  sleep: (seconds: number) => Promise<void>,
) => {
  const first = await get(fetcher, config, accessToken, path)
  if (first.status !== 429) return first
  await sleep(Number(first.headers.get("retry-after") ?? "1"))
  return get(fetcher, config, accessToken, path)
}

/** Run once after the code exchange; a failure is tolerated (undefined). */
export const profileId = async (fetcher: Fetcher, config: Config, accessToken: string) => {
  const response = await get(fetcher, config, accessToken, "/1/user/-/profile.json")
  if (!response.ok) return undefined
  return ((await response.json()) as { user?: { encodedId?: string } }).user?.encodedId
}

/** afterDate / sort=asc / limit=20, offset 0, 20, 40... while pagination.next is non-empty. */
export const syncActivities = async (
  fetcher: Fetcher,
  config: Config,
  accessToken: string,
  afterDate: string,
) => {
  const logs: Record<string, unknown>[] = []
  const requests: string[] = []
  for (let offset = 0; ; offset += 20) {
    const path = `/1/user/-/activities/list.json?afterDate=${afterDate}&sort=asc&limit=20&offset=${offset}`
    requests.push(path)
    const response = await get(fetcher, config, accessToken, path)
    if (!response.ok) return { status: response.status, logs, requests }
    const body = (await response.json()) as {
      activities: Record<string, unknown>[]
      pagination: { next: string }
    }
    logs.push(...body.activities)
    if (!body.pagination.next) return { status: 200, logs, requests }
  }
}

/** One request per calendar day in a window (UTC calendar days from `start`). */
export const days = (start: string, count: number) =>
  Array.from({ length: count }, (_, i) =>
    new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10),
  )
export const syncSleep = async (
  fetcher: Fetcher,
  config: Config,
  accessToken: string,
  window: string[],
) => {
  const sleep: Record<string, unknown>[] = []
  for (const day of window) {
    const response = await get(fetcher, config, accessToken, `/1/user/-/sleep/date/${day}.json`)
    if (!response.ok) return { status: response.status, sleep }
    sleep.push(...((await response.json()) as { sleep: Record<string, unknown>[] }).sleep)
  }
  return { status: 200, sleep }
}
export const syncSummaries = async (
  fetcher: Fetcher,
  config: Config,
  accessToken: string,
  window: string[],
) => {
  const summaries: Record<string, { steps: number; floors: number; total?: number }> = {}
  for (const day of window) {
    const response = await get(
      fetcher,
      config,
      accessToken,
      `/1/user/-/activities/date/${day}.json`,
    )
    if (!response.ok) return { status: response.status, summaries }
    const { summary } = (await response.json()) as {
      summary: {
        steps: number
        floors: number
        distances: { activity: string; distance: number }[]
      }
    }
    const total = summary.distances.find((d) => d.activity === "total")?.distance
    summaries[day] = {
      steps: summary.steps,
      floors: summary.floors,
      ...(total === undefined ? {} : { total }),
    }
  }
  return { status: 200, summaries }
}
