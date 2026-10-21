import { awsParseXml } from "@crvouga/mockingbird-service"

/**
 * Bucket CORS (https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html,
 * https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutBucketCors.html): the first rule whose
 * origin, method and (on a preflight) requested headers all match answers the request.
 */
export type CorsRule = {
  origins: string[]
  methods: string[]
  headers: string[]
  expose: string[]
  maxAge?: string
}
export const CORS_METHODS = ["GET", "PUT", "POST", "DELETE", "HEAD"]
export const PREFLIGHT_VARY = "Origin, Access-Control-Request-Headers, Access-Control-Request-Method"

const list = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value === undefined || value === "" ? [] : [value]).map(String)

/** The rules in a stored `CORSConfiguration` document, in order. */
export const parseCors = (body: string): CorsRule[] => {
  const root = (awsParseXml(body).CORSConfiguration ?? {}) as { CORSRule?: unknown }
  const rules = (Array.isArray(root.CORSRule) ? root.CORSRule : root.CORSRule ? [root.CORSRule] : []) as Record<string, unknown>[]
  return rules.map((rule) => ({
    origins: list(rule.AllowedOrigin),
    methods: list(rule.AllowedMethod),
    headers: list(rule.AllowedHeader),
    expose: list(rule.ExposeHeader),
    ...(rule.MaxAgeSeconds !== undefined ? { maxAge: String(rule.MaxAgeSeconds).trim() } : {}),
  }))
}

/** A message when a PutBucketCors document is invalid: `[code, message]`. */
export const invalidCors = (rules: CorsRule[]): [string, string] | undefined => {
  if (rules.length === 0 || rules.length > 100)
    return ["MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema"]
  for (const rule of rules) {
    if (rule.origins.length === 0 || rule.methods.length === 0)
      return ["MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema"]
    for (const method of rule.methods)
      if (!CORS_METHODS.includes(method))
        return ["InvalidRequest", `Found unsupported HTTP method in CORS config. Unsupported method is ${method}`]
    for (const [name, values] of [["AllowedOrigin", rule.origins], ["AllowedHeader", rule.headers]] as const)
      for (const value of values)
        if (value.split("*").length > 2)
          return ["InvalidRequest", `${name} "${value}" can not have more than one wildcard.`]
    if (rule.maxAge !== undefined && !/^\d+$/.test(rule.maxAge))
      return ["MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema"]
  }
  return undefined
}

const matches = (pattern: string, value: string) => {
  const star = pattern.indexOf("*")
  return star < 0
    ? pattern === value
    : value.length >= pattern.length - 1 &&
        value.startsWith(pattern.slice(0, star)) &&
        value.endsWith(pattern.slice(star + 1))
}

/** The first rule that allows this origin and method, and every requested header on a preflight. */
export const matchRule = (
  rules: CorsRule[],
  origin: string,
  method: string,
  requested: string[] = [],
): CorsRule | undefined =>
  rules.find(
    (rule) =>
      rule.origins.some((pattern) => matches(pattern, origin)) &&
      rule.methods.includes(method) &&
      requested.every((header) =>
        rule.headers.some((pattern) => matches(pattern.toLowerCase(), header)),
      ),
  )

/** `Access-Control-*` headers for a matched rule, shared by preflight and actual responses. */
export const corsHeaders = (rule: CorsRule, origin: string): Record<string, string> => {
  const any = rule.origins.includes("*")
  return {
    "access-control-allow-origin": any ? "*" : origin,
    "access-control-allow-methods": rule.methods.join(", "),
    ...(any ? {} : { "access-control-allow-credentials": "true" }),
    ...(rule.expose.length ? { "access-control-expose-headers": rule.expose.join(", ") } : {}),
  }
}
