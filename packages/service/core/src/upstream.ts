export type UpstreamState = { mode: "emulated" | "forward"; baseUrl: string }
export type UpstreamOptions = {
  fetch: (request: Request) => Response | Promise<Response>
  baseUrl: string
  mode?: "emulated" | "forward"
  rewriteAuth?: (request: Request) => Request | Promise<Request>
}

export const upstreamState = (value: unknown): UpstreamState => {
  if (typeof value !== "object" || value === null) throw new Error("expected upstream settings")
  const state = value as UpstreamState
  if (state.mode !== "emulated" && state.mode !== "forward")
    throw new Error("invalid upstream mode")
  const url = new URL(state.baseUrl)
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("upstream baseUrl must be an HTTP URL without credentials, query or fragment")
  return { mode: state.mode, baseUrl: url.toString() }
}

export const upstreamRequest = (request: Request, baseUrl: string): Request => {
  const source = new URL(request.url)
  const target = new URL(baseUrl)
  target.pathname = `${target.pathname.replace(/\/$/, "")}${source.pathname}`
  target.search = source.search
  const headers = new Headers(request.headers)
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith("x-mockingbird-") || name.toLowerCase() === "host")
      headers.delete(name)
  }
  return new Request(target, {
    method: request.method,
    headers,
    signal: request.signal,
    redirect: "manual",
    ...(request.method !== "GET" && request.method !== "HEAD"
      ? { body: request.body, duplex: "half" }
      : {}),
  })
}
