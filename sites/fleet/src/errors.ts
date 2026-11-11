/** An error the API reports to the caller as `{error: {code, message}}` with this status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** Extra response headers, e.g. `retry-after` on a 429. */
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
    this.name = "HttpError"
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, "invalid_request", message, details)
export const unauthorized = (message = "Sign in or send an API key") =>
  new HttpError(401, "unauthorized", message)
export const forbidden = (message = "You do not have access to this resource") =>
  new HttpError(403, "forbidden", message)
export const notFound = (what = "Resource") => new HttpError(404, "not_found", `${what} not found`)
export const conflict = (message: string) => new HttpError(409, "conflict", message)

export const errorResponse = (error: HttpError): Response =>
  Response.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    },
    { status: error.status, headers: error.headers },
  )
