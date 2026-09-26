import { jsonRes } from "@crvouga/mockingbird-service"

export type FieldError = { field: string; message: string }

/** Paddle's error envelope: `{error: {type, code, detail, documentation_url, errors?}, meta}`. */
export const errorBody = (
  status: number,
  code: string,
  detail: string,
  requestId: string,
  errors?: FieldError[],
) => ({
  error: {
    type: status >= 500 ? "api_error" : "request_error",
    code,
    detail,
    documentation_url: `https://developer.paddle.com/errors/shared/${code}`,
    ...(errors ? { errors } : {}),
  },
  meta: { request_id: requestId },
})

export class PaddleError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly errors?: FieldError[],
  ) {
    super(`${code}: ${detail}`)
    this.name = "PaddleError"
  }

  toResponse(requestId: string): Response {
    return jsonRes(
      this.status,
      errorBody(this.status, this.code, this.detail, requestId, this.errors),
    )
  }
}

export const notFound = (id: string) => new PaddleError(404, "not_found", `Entity ${id} not found`)

export const invalidField = (errors: FieldError[]) =>
  new PaddleError(400, "invalid_field", "Request does not pass validation", errors)

export const badRequest = (detail: string) => new PaddleError(400, "bad_request", detail)
