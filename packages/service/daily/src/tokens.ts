import { fromBase64, hmac, timingSafeEqual, toBase64 } from "@crvouga/mockingbird-service"

/**
 * Daily meeting tokens are HS256 JWTs signed with the domain's API key, their claims using
 * Daily's abbreviated property names. Our backend mints its own (self-signed) tokens the same
 * way, so the mock signs and verifies with the same scheme.
 */

/** Full property name → abbreviated JWT claim, as Daily documents them. */
export const CLAIM_NAMES: Record<string, string> = {
  room_name: "r",
  domain_id: "d",
  is_owner: "o",
  user_name: "u",
  user_id: "ud",
  knocking: "k",
  eject_at_token_exp: "ejt",
  eject_after_elapsed: "eje",
  enable_screenshare: "ss",
  start_video_off: "vo",
  start_audio_off: "ao",
  enable_recording: "er",
  enable_recording_ui: "erui",
  start_cloud_recording: "sr",
  start_cloud_recording_opts: "sro",
  auto_start_transcription: "ast",
  close_tab_on_exit: "ctoe",
  redirect_on_meeting_exit: "rome",
  lang: "uil",
  permissions: "p",
  nbf: "nbf",
  exp: "exp",
}

const PROPERTY_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(CLAIM_NAMES).map(([full, short]) => [short, full]),
)

/** Claims our backend's strict `DailySelfSignedTokenPayloadSchema` allows (plus `iat`). */
export const KNOWN_CLAIMS = new Set([...Object.values(CLAIM_NAMES), "iat"])

const encoder = new TextEncoder()

const base64url = (bytes: Uint8Array | string) =>
  toBase64(typeof bytes === "string" ? encoder.encode(bytes) : bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

const decodeSegment = (segment: string): unknown => {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/")
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    fromBase64(padded + "=".repeat((4 - (padded.length % 4)) % 4)),
  )
  return JSON.parse(text)
}

/** Claims → full property names (unknown claims keep their name). */
export const claimsToProperties = (claims: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [claim, value] of Object.entries(claims)) {
    if (claim === "iat") continue
    out[PROPERTY_NAMES[claim] ?? claim] = value
  }
  return out
}

/** Full property names → claims (properties without an abbreviation keep their name). */
export const propertiesToClaims = (
  properties: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(properties)) {
    if (value === undefined) continue
    out[CLAIM_NAMES[name] ?? name] = value
  }
  return out
}

/** Sign `claims` as an HS256 JWT with `key` (the Daily API key). */
export const signToken = async (claims: Record<string, unknown>, key: string): Promise<string> => {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const payload = base64url(JSON.stringify(claims))
  const signature = (await hmac("SHA-256", key, `${header}.${payload}`, "base64"))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  return `${header}.${payload}.${signature}`
}

export type DecodedToken = {
  header: Record<string, unknown>
  claims: Record<string, unknown>
  /** The signed part and the signature, for verification. */
  signingInput: string
  signature: string
}

/** Split and parse a JWT without verifying it; `undefined` when it is not a JWT at all. */
export const decodeToken = (token: string): DecodedToken | undefined => {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    const header = decodeSegment(parts[0] as string)
    const claims = decodeSegment(parts[1] as string)
    if (typeof header !== "object" || header === null) return undefined
    if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return undefined
    return {
      header: header as Record<string, unknown>,
      claims: claims as Record<string, unknown>,
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: parts[2] as string,
    }
  } catch {
    return undefined
  }
}

/** Whether `decoded` is an HS256 token signed with `key`. */
export const verifySignature = async (decoded: DecodedToken, key: string): Promise<boolean> => {
  if (decoded.header.alg !== "HS256") return false
  const expected = (await hmac("SHA-256", key, decoded.signingInput, "base64"))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  return timingSafeEqual(expected, decoded.signature)
}

/**
 * A timestamp that is really milliseconds (some of our callers pass `Date.parse(...)` or
 * `getTime()` where Daily expects seconds). Anything past year 5138 in seconds is ms.
 */
export const looksLikeMilliseconds = (value: unknown): value is number =>
  typeof value === "number" && Math.abs(value) >= 1e11

/** A Daily timestamp in epoch seconds, reading millisecond values as milliseconds. */
export const toSeconds = (value: unknown): number | undefined =>
  typeof value !== "number" || !Number.isFinite(value)
    ? undefined
    : looksLikeMilliseconds(value)
      ? Math.floor(value / 1000)
      : value
