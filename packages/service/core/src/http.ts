import { JSON_MEDIA_TYPE } from "@crvouga/mockingbird-http-codec"

/** JSON response with a normalised content type. */
export const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": JSON_MEDIA_TYPE, ...headers },
  })

/** Thrown by handlers to produce a provider-shaped error response via `onError`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly headers: Record<string, string> = {},
  ) {
    super(`HTTP ${status}`)
    this.name = "HttpError"
  }

  toResponse(): Response {
    return jsonResponse(this.status, this.body, this.headers)
  }
}

export type FieldResult<T> = { ok: true; value: T } | { ok: false; reason: string }

const ok = <T>(value: T): FieldResult<T> => ({ ok: true, value })
const fail = <T>(reason: string): FieldResult<T> => ({ ok: false, reason })

/** Form bodies decode to strings; these coerce the way HTTP servers do, reporting why not. */
export const coerce = {
  string(value: unknown): FieldResult<string> {
    return typeof value === "string" ? ok(value) : fail("expected a string")
  },
  integer(value: unknown): FieldResult<number> {
    if (typeof value === "number" && Number.isInteger(value)) return ok(value)
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
      const parsed = Number(value)
      return Number.isSafeInteger(parsed) ? ok(parsed) : fail("integer out of range")
    }
    return fail("expected an integer")
  },
  boolean(value: unknown): FieldResult<boolean> {
    if (typeof value === "boolean") return ok(value)
    if (value === "true" || value === "1") return ok(true)
    if (value === "false" || value === "0") return ok(false)
    return fail("expected a boolean")
  },
  enumeration<T extends string>(value: unknown, allowed: readonly T[]): FieldResult<T> {
    const match = allowed.find((candidate) => candidate === value)
    return match === undefined ? fail(`expected one of ${allowed.join(", ")}`) : ok(match)
  },
  /** Flat string-to-string map, the shape of Stripe-style `metadata`. */
  stringMap(value: unknown): FieldResult<Record<string, string>> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return fail("expected an object")
    const out: Record<string, string> = {}
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== "string") return fail(`expected a string at ${key}`)
      out[key] = item
    }
    return ok(out)
  },
}

/** Count Unicode code points, the way JSON Schema and most APIs measure string length. */
export const codePointLength = (value: string) => [...value].length
