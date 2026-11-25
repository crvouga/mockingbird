import probeCorpus from "../corpus/probe-calls.json" with { type: "json" }

export type ProbeCall = (typeof probeCorpus.calls)[number]

export const PROBE_CALLS: readonly ProbeCall[] = probeCorpus.calls

export const REPLAY_CLIENT = { clientId: "<redacted>", secret: "replay-secret" } as const

export type Deviation = { case: string; path: string; reason: string }

export const KNOWN_DEVIATIONS: readonly Deviation[] = [
  {
    case: "statuses-page",
    path: "data.total",
    reason:
      "The sandbox listed 91 statuses during the probe and 89 in the reference export taken the same day; only the first 50 are recorded, so the emulator seeds the 89 it knows.",
  },
]

const VOLATILE_KEYS = new Set([
  "createdOn",
  "lastUpdatedOn",
  "issuedAt",
  "expiresAt",
  "lastUsedOn",
  "access_token",
  "secret",
])

export const normalize = (value: unknown, path = ""): unknown => {
  if (Array.isArray(value)) return value.map((entry, i) => normalize(entry, `${path}.${i}`))
  if (value === null || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (VOLATILE_KEYS.has(key)) out[key] = typeof entry === "string" ? "<volatile>" : entry
    else if (key === "id" && path.endsWith(".token")) out[key] = "<token-id>"
    else out[key] = normalize(entry, `${path}.${key}`)
  }
  return out
}

export type Difference = { path: string; expected: unknown; actual: unknown }

export const differences = (expected: unknown, actual: unknown, path = ""): Difference[] => {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const out: Difference[] = []
    if (expected.length !== actual.length) {
      out.push({ path: `${path}.length`, expected: expected.length, actual: actual.length })
    }
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) {
      out.push(...differences(expected[i], actual[i], `${path}.${i}`))
    }
    return out
  }
  if (
    expected !== null &&
    actual !== null &&
    typeof expected === "object" &&
    typeof actual === "object" &&
    !Array.isArray(expected) &&
    !Array.isArray(actual)
  ) {
    const out: Difference[] = []
    const e = expected as Record<string, unknown>
    const a = actual as Record<string, unknown>
    for (const key of new Set([...Object.keys(e), ...Object.keys(a)])) {
      const next = path ? `${path}.${key}` : key
      if (!(key in a)) out.push({ path: next, expected: e[key], actual: "<missing>" })
      else if (!(key in e)) out.push({ path: next, expected: "<missing>", actual: a[key] })
      else out.push(...differences(e[key], a[key], next))
    }
    return out
  }
  return Object.is(expected, actual) ? [] : [{ path, expected, actual }]
}

export type ReplayOutcome = {
  run: string
  step: number
  case: string
  method: string
  path: string
  expectedStatus: number
  actualStatus: number
  rateLimit: { expected: number | null; actual: number | null }
  differences: Difference[]
  tolerated: Difference[]
}

const runStart = (run: string) => {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(run)
  if (!match) throw new Error(`unexpected run name ${run}`)
  const [, y, mo, d, h, mi, s] = match
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`
}

export type ReplayTarget = {
  fetch: (request: Request) => Promise<Response>
  base: string
  namespace: string
}

const bearerFor = (call: ProbeCall, token: string | undefined) => {
  if (call.auth === "bearer-malformed") return "Bearer not-a-jwt"
  if (call.auth === "bearer-valid" && token) return `Bearer ${token}`
  return undefined
}

export const replay = async (target: ReplayTarget): Promise<ReplayOutcome[]> => {
  const outcomes: ReplayOutcome[] = []
  let token: string | undefined
  let currentRun = ""
  for (const call of PROBE_CALLS) {
    const headers = new Headers({
      accept: "application/json",
      "x-mockingbird-namespace": target.namespace,
      "x-mockingbird-delay": `${call.latencyMs}ms`,
    })
    if (call.run !== currentRun) {
      currentRun = call.run
      headers.set("x-mockingbird-time", runStart(call.run))
      headers.set("x-mockingbird-virtual-time", "true")
    }
    if (call.waitBeforeMs > 0) headers.set("x-mockingbird-advance", `${call.waitBeforeMs}ms`)
    if (call.vendorHeader) headers.set("x-vendor-id", "10001")
    let body: string | undefined
    if (call.path === "/auth/token") {
      headers.set("content-type", "application/x-www-form-urlencoded")
      body = new URLSearchParams({
        grant_type: String((call.body as { grant_type?: string }).grant_type ?? ""),
        client_id: REPLAY_CLIENT.clientId,
        client_secret: call.auth === "token-wrong-secret" ? "not-the-secret" : REPLAY_CLIENT.secret,
      }).toString()
    } else {
      const bearer = bearerFor(call, token)
      if (bearer) headers.set("authorization", bearer)
      if (call.body !== null && call.body !== undefined) {
        headers.set("content-type", "application/json")
        body = JSON.stringify(call.body)
      }
    }
    const response = await target.fetch(
      new Request(`${target.base}/api/v2${call.path}`, {
        method: call.method,
        headers,
        ...(body === undefined ? {} : { body }),
      }),
    )
    const text = await response.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {}
    if (call.path === "/auth/token" && response.status === 200) {
      token = (parsed as { access_token?: string }).access_token
    }
    const all = differences(normalize(call.response), normalize(parsed))
    const tolerated = all.filter((d) =>
      KNOWN_DEVIATIONS.some((k) => k.case === call.case && k.path === d.path),
    )
    const limit = response.headers.get("x-ratelimit-limit")
    outcomes.push({
      run: call.run,
      step: call.step,
      case: call.case,
      method: call.method,
      path: call.path,
      expectedStatus: call.status,
      actualStatus: response.status,
      rateLimit: {
        expected: call.rateLimit?.limit ?? null,
        actual: limit === null ? null : Number(limit),
      },
      differences: all.filter((d) => !tolerated.includes(d)),
      tolerated,
    })
  }
  return outcomes
}

export const failures = (outcomes: readonly ReplayOutcome[]) =>
  outcomes.filter(
    (o) =>
      o.expectedStatus !== o.actualStatus ||
      o.differences.length > 0 ||
      o.rateLimit.expected !== o.rateLimit.actual,
  )
