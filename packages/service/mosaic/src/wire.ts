import {
  bodyIssues,
  IdSequence,
  jsonRes,
  type OperationContext,
} from "@crvouga/mockingbird-service"

export const apiKey = (request: Request) => request.headers.get("ApiKey")?.trim() || undefined

export const unauthenticated = () =>
  new Response("Api Key was not provided", {
    status: 401,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })

export const envelope = <T>(data: T, error: string | null = null, success = error === null) => ({
  data,
  error,
  success,
})

export const ok = (data: unknown) => jsonRes(200, envelope(data))

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const integer = (value: unknown): value is number => Number.isSafeInteger(value)
export const parseWireDate = (value: string) =>
  Date.parse(/T/.test(value) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? `${value}Z` : value)

export const textDate = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}.*)?$/.test(value) &&
  Number.isFinite(parseWireDate(value))
export const wireDate = (time: number) => new Date(time).toISOString().slice(0, 19)

export const problem = (
  scope: Pick<OperationContext, "sqlite" | "namespace">,
  status: 400 | 404 | 415 | 500,
  errors?: Record<string, string[]>,
) => {
  const details = {
    400: ["15.5.1", "Bad Request"],
    404: ["15.5.5", "Not Found"],
    415: ["15.5.16", "Unsupported Media Type"],
    500: ["15.6.1", "Internal Server Error"],
  } as const
  const [section, title] = details[status]
  const ids = new IdSequence(scope.sqlite, scope.namespace, "mosaic")
  const hex = Array.from(ids.next("problem", 24).slice(-24), (character) =>
    character.charCodeAt(0).toString(16),
  ).join("")
  return Response.json(
    {
      type: `https://tools.ietf.org/html/rfc9110#section-${section}`,
      title: errors ? "One or more validation errors occurred." : title,
      status,
      traceId: `00-${hex.slice(0, 32)}-${hex.slice(32)}-00`,
      ...(errors ? { errors } : {}),
    },
    { status, headers: { "content-type": "application/problem+json" } },
  )
}

export const input = <T>(context: OperationContext, read: (body: T) => Response) => {
  const issues = bodyIssues(context)
  if (issues.some((issue) => issue.kind === "media_type")) return problem(context, 415)
  if (context.body.kind !== "json" || !isRecord(context.body.value)) return problem(context, 400)
  if (issues.length) {
    const errors: Record<string, string[]> = {}
    for (const { path, message } of issues) {
      const missing = /^missing required property (.+)$/.exec(message)
      const name = [path, missing?.[1]].filter(Boolean).join(".") || "$"
      const field = name.charAt(0).toUpperCase() + name.slice(1)
      const detail = missing ? `The ${field} field is required.` : message
      errors[field] = [...(errors[field] ?? []), detail]
    }
    return problem(context, 400, errors)
  }
  return read(context.body.value as T)
}

export const queryValue = (context: OperationContext, name: string) => {
  const key = name.toLowerCase()
  for (const [actual, value] of context.url.searchParams) {
    if (actual.toLowerCase() === key) return value || undefined
  }
  return undefined
}

type QueryField = readonly [name: string, kind: "id" | "date" | "text"]

export const query = (
  context: OperationContext,
  fields: readonly QueryField[],
  read: (value: (name: string) => string | undefined) => Response,
) => {
  const get = (name: string) => queryValue(context, name)
  for (const [name, kind] of fields) {
    const value = get(name)
    if (value === undefined || kind === "text") continue
    if (kind === "id" && (!/^-?\d+$/.test(value) || !integer(Number(value))))
      return problem(context, 400)
    if (kind === "date" && !textDate(value)) return problem(context, 400)
  }
  return read(get)
}
