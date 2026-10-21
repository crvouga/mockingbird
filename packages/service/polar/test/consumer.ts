// HTTP port of the issue's raw-httpx adapter (issue #546). The request shapes, the strict item
// parse, the 401 -> re-authorize rule and the 429 retry are the consumer's; nothing here is the
// emulator's. Where the issue and the reference disagree the code follows the issue.
export type Fetcher = (request: Request) => Promise<Response>

export const SCOPE = "accesslink.read_all"
/** The consumer's wait when a 429 carries no Retry-After. */
export const DEFAULT_RETRY_SECONDS = 5

/** The token is long-lived and has no refresh grant, so a 401 ends the connection. */
export class ReauthorizationRequired extends Error {
  constructor() {
    super("Polar connection needs re-authorization")
  }
}

/** The consent URL the user's browser is sent to. `redirect_uri` is deliberately not encoded. */
export const authorizeUrl = (
  authorizeBase: string,
  params: { clientId: string; redirectUri: string; state: string },
) =>
  `${authorizeBase}/oauth2/authorization?response_type=code&client_id=${params.clientId}` +
  `&redirect_uri=${params.redirectUri}&state=${params.state}&scope=${SCOPE}`

/** What the browser lands on: `redirect_uri?code=&state=` or `?error=&error_description=`. */
export const followConsent = async (fetcher: Fetcher, url: string) => {
  const response = await fetcher(new Request(url, { redirect: "manual" }))
  const location = response.headers.get("location")
  if (response.status !== 302 || !location)
    return { status: response.status, body: await response.text() }
  const back = new URL(location)
  return {
    status: 302,
    location,
    code: back.searchParams.get("code"),
    state: back.searchParams.get("state"),
    error: back.searchParams.get("error"),
    errorDescription: back.searchParams.get("error_description"),
  }
}

export type Token = { accessToken: string; tokenType: string; expiresIn: number; xUserId: number }

const basic = (id: string, secret: string) => `Basic ${btoa(`${id}:${secret}`)}`

export const tokenRequest = (
  tokenBase: string,
  params: { clientId: string; clientSecret: string; code?: string; redirectUri?: string },
  grantType = "authorization_code",
) =>
  new Request(`${tokenBase}/v2/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: basic(params.clientId, params.clientSecret),
    },
    body: new URLSearchParams({
      grant_type: grantType,
      ...(params.code === undefined ? {} : { code: params.code }),
      ...(params.redirectUri === undefined ? {} : { redirect_uri: params.redirectUri }),
    }),
  })

/** The code exchange. `expires_in` and `x_user_id` must be integers or the connection fails. */
export const exchangeCode = async (
  fetcher: Fetcher,
  tokenBase: string,
  params: { clientId: string; clientSecret: string; code: string; redirectUri: string },
): Promise<{ ok: true; token: Token } | { ok: false; status: number; error: string }> => {
  const response = await fetcher(tokenRequest(tokenBase, params))
  const body = (await response.json()) as Record<string, unknown>
  if (!response.ok) return { ok: false, status: response.status, error: String(body.error) }
  if (
    typeof body.access_token !== "string" ||
    typeof body.token_type !== "string" ||
    !Number.isInteger(body.expires_in) ||
    !Number.isInteger(body.x_user_id)
  )
    throw new Error("malformed Polar token response")
  return {
    ok: true,
    token: {
      accessToken: body.access_token,
      tokenType: body.token_type,
      expiresIn: body.expires_in as number,
      xUserId: body.x_user_id as number,
    },
  }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/json" })

/** Once after the code exchange. The status is ignored: 200 and 409 are both fine. */
export const registerUser = async (
  fetcher: Fetcher,
  apiBase: string,
  token: string,
  memberId: string,
) => {
  const response = await fetcher(
    new Request(`${apiBase}/v3/users`, {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify({ "member-id": memberId }),
    }),
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

export type Exercise = {
  id: string
  device: string
  sport: string
  detailedSportInfo: string | null
  startTime: string
  startTimeUtcOffsetMinutes: number
  durationSeconds: number
  calories: number | null
  distance: number | null
  heartRateAverage: number | null
  heartRateMaximum: number | null
}

/** ISO 8601 duration to seconds (`PT2H44M` -> 9840). */
export const durationSeconds = (value: string): number => {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value)
  if (!match) throw new Error(`bad duration ${value}`)
  const [, d, h, m, s] = match
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)
}

const text = (v: unknown, field: string) => {
  if (typeof v !== "string") throw new Error(`exercise.${field} missing`)
  return v
}
const optionalNumber = (v: unknown) => (typeof v === "number" ? v : null)

/** One item. A missing `id`, `device`, `sport`, `start_time`, offset or `duration` fails the list. */
export const parseExercise = (raw: unknown): Exercise => {
  const item = raw as Record<string, unknown>
  const heart = (item.heart_rate ?? {}) as Record<string, unknown>
  if (!Number.isInteger(item.start_time_utc_offset)) throw new Error("exercise.offset missing")
  return {
    id: text(item.id, "id"),
    device: text(item.device, "device"),
    sport: text(item.sport, "sport"),
    detailedSportInfo:
      typeof item.detailed_sport_info === "string" ? item.detailed_sport_info : null,
    startTime: text(item.start_time, "start_time"),
    startTimeUtcOffsetMinutes: item.start_time_utc_offset as number,
    durationSeconds: durationSeconds(text(item.duration, "duration")),
    calories: optionalNumber(item.calories),
    distance: optionalNumber(item.distance),
    heartRateAverage: optionalNumber(heart.average),
    heartRateMaximum: optionalNumber(heart.maximum),
  }
}

export type CallOptions = { sleep?: (seconds: number) => Promise<void> }

/** Any API route: 401 means re-authorize; 429 waits Retry-After (default 5 s) and retries once. */
const call = async (fetcher: Fetcher, request: () => Request, options: CallOptions) => {
  let response = await fetcher(request())
  if (response.status === 429) {
    const header = response.headers.get("retry-after")
    const seconds =
      header !== null && Number.isFinite(Number(header)) ? Number(header) : DEFAULT_RETRY_SECONDS
    await (options.sleep ?? ((s) => new Promise((r) => setTimeout(r, s * 1000))))(seconds)
    response = await fetcher(request())
  }
  if (response.status === 401) throw new ReauthorizationRequired()
  return response
}

const FLAGS = "samples=false&zones=false&route=false"

export const listExercises = async (
  fetcher: Fetcher,
  apiBase: string,
  token: string,
  options: CallOptions = {},
): Promise<{ status: number; exercises: Exercise[] }> => {
  const response = await call(
    fetcher,
    () => new Request(`${apiBase}/v3/exercises?${FLAGS}`, { headers: bearer(token) }),
    options,
  )
  if (!response.ok) return { status: response.status, exercises: [] }
  const items = (await response.json()) as unknown[]
  if (!Array.isArray(items)) throw new Error("exercise list is not an array")
  return { status: 200, exercises: items.map(parseExercise) }
}

export const getExercise = async (
  fetcher: Fetcher,
  apiBase: string,
  token: string,
  id: string,
  options: CallOptions = {},
): Promise<{ status: number; exercise?: Exercise }> => {
  const response = await call(
    fetcher,
    () => new Request(`${apiBase}/v3/exercises/${id}?${FLAGS}`, { headers: bearer(token) }),
    options,
  )
  if (!response.ok) return { status: response.status }
  return { status: 200, exercise: parseExercise(await response.json()) }
}
