import { Collection, seedFrom } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type EdgeCase =
  | "hideEmail"
  | "omitEmail"
  | "omitName"
  | "unverifiedEmail"
  | "denyConsent"
  | "tokenUnavailable"
  | "invalidGrant"
export type OAuthBehavior = {
  /** False always requires account selection, including silent authentication requests. */
  session?: { reuseLastAccount?: boolean }
  /** Each probability is in [0,1]. Defaults are zero; randomness is opt-in. */
  probabilities?: Partial<Record<EdgeCase, number>>
  apple?: {
    emailMode?: "choose" | "hide" | "share"
    booleanClaims?: "string" | "boolean"
    omitUser?: boolean
  }
  google?: {
    refreshToken?: "first-consent" | "always" | "never"
    testing?: boolean
    maxRefreshTokens?: number
  }
  claims?: { omitEmail?: boolean; omitName?: boolean; unverifiedEmail?: boolean }
  consent?: {
    deniedScopes?: string[]
    error?: "access_denied" | "interaction_required" | "temporarily_unavailable"
  }
  tokens?: {
    accessTtlSeconds?: number
    codeTtlSeconds?: number
    refreshTtlSeconds?: number
    refreshRotation?: "reuse" | "rotate"
    refreshError?: "invalid_grant" | "invalid_rapt"
  }
  /** Additional scopes accepted for incremental/partial-consent tests. No resource APIs implied. */
  additionalScopes?: string[]
}
export const OAUTH_SCENARIOS = {
  apple_private_relay: { apple: { emailMode: "hide" } },
  apple_share_email: { apple: { emailMode: "share" } },
  apple_returning_user: { apple: { omitUser: true } },
  apple_boolean_claims: { apple: { booleanClaims: "boolean" } },
  microsoft_missing_email: { claims: { omitEmail: true } },
  microsoft_spa_expiry: { tokens: { refreshTtlSeconds: 86400 } },
  github_unverified_email: { claims: { unverifiedEmail: true } },
  missing_email: { claims: { omitEmail: true } },
  missing_name: { claims: { omitName: true } },
  unverified_email: { claims: { unverifiedEmail: true } },
  google_no_refresh_token: { google: { refreshToken: "never" } },
  google_reauthentication: { tokens: { refreshError: "invalid_rapt" } },
  revoked_refresh_token: { tokens: { refreshError: "invalid_grant" } },
  rotating_refresh_tokens: { tokens: { refreshRotation: "rotate" } },
  short_lived_tokens: { tokens: { accessTtlSeconds: 5, codeTtlSeconds: 5, refreshTtlSeconds: 30 } },
  consent_denied: { consent: { error: "access_denied" } },
  intermittent_token_failure: { probabilities: { tokenUnavailable: 0.25 } },
} as const satisfies Record<string, OAuthBehavior>
export type OAuthScenario = keyof typeof OAUTH_SCENARIOS
export type BehaviorInput = OAuthBehavior & { preset?: OAuthScenario }
export type Decisions = {
  hideEmail: boolean
  omitEmail: boolean
  omitName: boolean
  unverifiedEmail: boolean
  denyConsent: boolean
}
export type BehaviorEvent = { sequence: number; stage: string; outcomes: Record<string, boolean> }

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
const keys = (value: Record<string, unknown>, allowed: string[]) => {
  for (const k of Object.keys(value))
    if (!allowed.includes(k)) throw new Error(`Unknown behavior option: ${k}`)
}
const enumeration = (v: unknown, values: unknown[]) => {
  if (v !== undefined && !values.includes(v))
    throw new Error(`Expected one of ${values.join(", ")}`)
}
const strings = (v: unknown) => {
  if (
    v !== undefined &&
    (!Array.isArray(v) || v.some((s) => typeof s !== "string" || !s || /\s/.test(s)))
  )
    throw new Error("Scopes must be nonempty strings without whitespace")
}
export function validateBehavior(input: unknown): OAuthBehavior {
  if (!object(input)) throw new Error("Behavior must be an object")
  keys(input, [
    "preset",
    "session",
    "probabilities",
    "apple",
    "google",
    "claims",
    "consent",
    "tokens",
    "additionalScopes",
  ])
  if (
    input.preset !== undefined &&
    (typeof input.preset !== "string" || !Object.hasOwn(OAUTH_SCENARIOS, input.preset))
  )
    throw new Error("Unknown OAuth scenario")
  for (const key of ["probabilities", "apple", "google", "claims", "consent", "tokens", "session"])
    if (input[key] !== undefined && !object(input[key])) throw new Error(`${key} must be an object`)
  const session = input.session as Record<string, unknown> | undefined
  if (session) {
    keys(session, ["reuseLastAccount"])
    enumeration(session.reuseLastAccount, [true, false])
  }
  const p = input.probabilities as Record<string, unknown> | undefined
  if (p) {
    keys(p, [
      "hideEmail",
      "omitEmail",
      "omitName",
      "unverifiedEmail",
      "denyConsent",
      "tokenUnavailable",
      "invalidGrant",
    ])
    for (const v of Object.values(p))
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)
        throw new Error("Probabilities must be finite numbers in [0,1]")
  }
  const apple = input.apple as Record<string, unknown> | undefined
  if (apple) {
    keys(apple, ["emailMode", "booleanClaims", "omitUser"])
    enumeration(apple.emailMode, ["choose", "hide", "share"])
    enumeration(apple.booleanClaims, ["string", "boolean"])
    enumeration(apple.omitUser, [true, false])
  }
  const google = input.google as Record<string, unknown> | undefined
  if (google) {
    keys(google, ["refreshToken", "testing", "maxRefreshTokens"])
    enumeration(google.refreshToken, ["first-consent", "always", "never"])
    enumeration(google.testing, [true, false])
    if (
      google.maxRefreshTokens !== undefined &&
      (typeof google.maxRefreshTokens !== "number" ||
        !Number.isSafeInteger(google.maxRefreshTokens) ||
        google.maxRefreshTokens < 1 ||
        google.maxRefreshTokens > 1000)
    )
      throw new Error("maxRefreshTokens must be an integer in [1,1000]")
  }
  const claims = input.claims as Record<string, unknown> | undefined
  if (claims) {
    keys(claims, ["omitEmail", "omitName", "unverifiedEmail"])
    for (const v of Object.values(claims)) enumeration(v, [true, false])
  }
  const consent = input.consent as Record<string, unknown> | undefined
  if (consent) {
    keys(consent, ["deniedScopes", "error"])
    strings(consent.deniedScopes)
    enumeration(consent.error, ["access_denied", "interaction_required", "temporarily_unavailable"])
  }
  const tokens = input.tokens as Record<string, unknown> | undefined
  if (tokens) {
    keys(tokens, [
      "accessTtlSeconds",
      "codeTtlSeconds",
      "refreshTtlSeconds",
      "refreshRotation",
      "refreshError",
    ])
    enumeration(tokens.refreshRotation, ["reuse", "rotate"])
    enumeration(tokens.refreshError, ["invalid_grant", "invalid_rapt"])
    for (const key of ["accessTtlSeconds", "codeTtlSeconds", "refreshTtlSeconds"]) {
      const v = tokens[key]
      if (
        v !== undefined &&
        (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > 315360000)
      )
        throw new Error(`${key} must be an integer in [1,315360000]`)
    }
  }
  strings(input.additionalScopes)
  const { preset, ...config } = input as BehaviorInput
  const base: OAuthBehavior = preset ? structuredClone(OAUTH_SCENARIOS[preset]) : {}
  return {
    ...base,
    ...structuredClone(config),
    ...Object.fromEntries(
      ["probabilities", "apple", "google", "claims", "consent", "tokens", "session"]
        .filter((k) => k in base || k in config)
        .map((k) => [
          k,
          {
            ...(base[k as keyof OAuthBehavior] as object),
            ...(config[k as keyof OAuthBehavior] as object),
          },
        ]),
    ),
  }
}

/** Only behavioral choices use seeded randomness. Tokens remain cryptographically random. */
export class BehaviorState {
  private readonly state: Collection<{
    config: OAuthBehavior
    cursor: number
    events: BehaviorEvent[]
  }>
  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: number | string,
    initial: BehaviorInput,
  ) {
    this.state = new Collection(sqlite, namespace, "oauth_behavior")
    if (!this.state.has("state")) this.configure(initial)
  }
  configure(input: unknown): OAuthBehavior {
    const config = validateBehavior(input)
    this.state.insert("state", { config, cursor: 0, events: [] })
    return config
  }
  get config(): OAuthBehavior {
    return this.state.get("state")?.config ?? {}
  }
  get events(): BehaviorEvent[] {
    return this.state.get("state")?.events ?? []
  }
  sample(stage: string, names: EdgeCase[]): Record<string, boolean> {
    const state = this.state.get("state") ?? { config: {}, cursor: 0, events: [] }
    const sequence = state.cursor++
    const outcomes = Object.fromEntries(
      names.map((name) => [
        name,
        seedFrom(`${this.seed}:${sequence}:${name}`) / 4294967296 <
          (state.config.probabilities?.[name] ?? 0),
      ]),
    )
    state.events.push({ sequence, stage, outcomes })
    state.events = state.events.slice(-100)
    this.state.insert("state", state)
    return outcomes
  }
  decisions(): Decisions {
    const sampled = this.sample("authorization", [
      "hideEmail",
      "omitEmail",
      "omitName",
      "unverifiedEmail",
      "denyConsent",
    ])
    return {
      hideEmail: sampled.hideEmail ?? false,
      omitEmail: !!(sampled.omitEmail || this.config.claims?.omitEmail),
      omitName: !!(sampled.omitName || this.config.claims?.omitName),
      unverifiedEmail: !!(sampled.unverifiedEmail || this.config.claims?.unverifiedEmail),
      denyConsent: sampled.denyConsent ?? false,
    }
  }
}
