import { DEFAULT_ADMIN_KEY, DEFAULT_TOKEN } from "../src/index.js"
export const consumer = (
  mock: { fetch: (request: Request) => Promise<Response> },
  namespace?: string,
) => {
  const request = (path: string, init: RequestInit = {}) =>
    mock.fetch(
      new Request(new URL(path, "http://mock.local"), {
        ...init,
        headers: {
          authorization: `Bearer ${DEFAULT_TOKEN}`,
          ...(namespace ? { "x-mockingbird-namespace": namespace } : {}),
          ...Object.fromEntries(new Headers(init.headers)),
        },
      }),
    )
  const json = (path: string, body: unknown, init: RequestInit = {}) =>
    request(path, {
      ...init,
      method: init.method ?? "POST",
      headers: {
        "content-type": "application/json",
        ...Object.fromEntries(new Headers(init.headers)),
      },
      body: JSON.stringify(body),
    })
  const admin = (path: string, body?: unknown) =>
    body === undefined
      ? request(`/__admin${path}`, { headers: { "x-mockingbird-admin-key": DEFAULT_ADMIN_KEY } })
      : json(`/__admin${path}`, body, { headers: { "x-mockingbird-admin-key": DEFAULT_ADMIN_KEY } })
  return {
    request,
    json,
    admin,
    chat: (body: unknown, signal?: AbortSignal) =>
      json("/v1/chat/completions", body, { ...(signal ? { signal } : {}) }),
  }
}
/** Retry network errors, 429 and 5xx responses. */
export const retryChat = async (
  c: ReturnType<typeof consumer>,
  body: unknown,
  maxRetries = 2,
): Promise<Response> => {
  for (let attempt = 0; ; attempt++) {
    let response: Response
    try {
      response = await c.chat(body)
    } catch (error) {
      if (attempt >= maxRetries) throw error
      continue
    }
    if (attempt >= maxRetries || !(response.status === 429 || response.status >= 500))
      return response
    await response.body?.cancel()
  }
}
