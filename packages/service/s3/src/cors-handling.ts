/**
 * Bucket CORS, enforced the way Amazon S3 documents it. MinIO only stubs the bucket CORS API
 * (`PutBucketCors` is NotImplemented there), so this is the one area that follows AWS rather than
 * the MinIO oracle: the emulator is a superset, never a subset.
 */
import {
  CORS_METHODS,
  type CorsRule,
  corsHeaders,
  matchRule,
  PREFLIGHT_VARY,
  parseCors,
} from "./cors.js"
import { S3Error } from "./errors.js"
import type { S3Core } from "./store.js"

const rules = (core: S3Core, bucket: string): CorsRule[] | undefined => {
  const stored = core.config(bucket, "cors")
  return stored ? parseCors(stored) : undefined
}

/** The browser preflight (`OPTIONS` on a bucket or object URL). */
export const corsPreflight = async (
  core: S3Core,
  bucket: string,
  request: Request,
  url: URL,
): Promise<Response> => {
  if (!core.bucket(bucket)) throw new S3Error("NoSuchBucket", { bucket })
  const origin = request.headers.get("origin")
  if (!origin)
    throw new S3Error("BadRequest", {
      message: "Insufficient information. Origin request header needed.",
    })
  const method = request.headers.get("access-control-request-method")
  if (!method || !CORS_METHODS.includes(method))
    throw new S3Error("BadRequest", { message: `Invalid Access-Control-Request-Method: ${method}` })
  const requested = (request.headers.get("access-control-request-headers") ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
  const configured = rules(core, bucket)
  const refuse = (message: string) =>
    new S3Error("AccessDenied", {
      code: "AccessForbidden",
      message: `CORSResponse: ${message}`,
      fields: {
        Method: method,
        ResourceType: url.pathname.indexOf("/", 1) < 0 ? "BUCKET" : "OBJECT",
      },
      bucket: "",
      resource: decodeURIComponent(url.pathname),
    })
  if (!configured) throw refuse("CORS is not enabled for this bucket.")
  const rule = matchRule(configured, origin, method, requested)
  if (!rule)
    throw refuse(
      "This CORS request is not allowed. This is usually because the evalution of Origin, request method / Access-Control-Request-Method or Access-Control-Request-Headers are not whitelisted by the resource's CORS spec.",
    )
  return new Response(null, {
    status: 200,
    headers: {
      ...corsHeaders(rule, origin),
      ...(requested.length ? { "access-control-allow-headers": requested.join(", ") } : {}),
      ...(rule.maxAge ? { "access-control-max-age": rule.maxAge } : {}),
      vary: PREFLIGHT_VARY,
    },
  })
}

/** A matching rule adds the `Access-Control-*` headers to an actual cross-origin response. */
export const withCors = (
  core: S3Core,
  bucket: string,
  request: Request,
  response: Response,
): Response => {
  const origin = request.headers.get("origin")
  if (!origin || !bucket || request.method === "OPTIONS" || !core.bucket(bucket)) return response
  const rule = matchRule(rules(core, bucket) ?? [], origin, request.method)
  if (!rule) return response
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(corsHeaders(rule, origin))) headers.set(name, value)
  headers.append("vary", "Origin")
  return new Response(response.body, { status: response.status, headers })
}
