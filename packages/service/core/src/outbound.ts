/** Policy only for runtime-owned HTTP sends; it does not sandbox DNS or arbitrary sockets. */
export type OutboundPolicy = {
  mode: "offline" | "allowlist"
  origins?: string[]
  maxRedirects?: number
  maxBodyBytes?: number
  onReject?(event: { namespace: string; policy: string; reason: string }): void
}
export type OwnedTransport = (
  request: Request,
  namespace: string,
  send: typeof fetch,
) => Promise<Response>
export function ownedTransport(policy: OutboundPolicy): OwnedTransport {
  if (
    !["offline", "allowlist"].includes(policy.mode) ||
    policy.origins?.some((origin) => {
      try {
        return new URL(origin).origin !== origin
      } catch {
        return true
      }
    })
  )
    throw new Error("invalid outbound transport policy")
  const reject = (namespace: string, reason: string): never => {
    try {
      policy.onReject?.({ namespace, policy: policy.mode, reason })
    } catch {}
    throw new Error(`outbound policy ${policy.mode}: ${reason}`)
  }
  return async (request, namespace, send) => {
    if (policy.mode === "offline") return reject(namespace, "delivery disabled")
    const allowed = (url: URL) =>
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      (policy.origins ?? []).includes(url.origin)
    let url = new URL(request.url)
    if (!allowed(url)) return reject(namespace, "destination not allowed")
    const max = policy.maxBodyBytes ?? 1024 * 1024
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = request.body?.getReader()
    if (reader)
      try {
        for (;;) {
          const item = await reader.read()
          if (item.done) break
          size += item.value.length
          if (size > max) return reject(namespace, "body limit exceeded")
          chunks.push(item.value)
        }
      } finally {
        void reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    const body = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.length
    }
    let method = request.method,
      headers = new Headers(request.headers)
    for (let redirects = 0; ; redirects++) {
      if (!allowed(url)) return reject(namespace, "redirect destination not allowed")
      const response = await send(
        new Request(url, {
          method,
          headers,
          ...(method !== "GET" && method !== "HEAD" ? { body } : {}),
          redirect: "manual",
          signal: request.signal,
        }),
      )
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      const location = response.headers.get("location")
      if (!location) return response
      await response.body?.cancel()
      if (redirects >= (policy.maxRedirects ?? 5))
        return reject(namespace, "redirect limit exceeded")
      const next = new URL(location, url)
      if (next.origin !== url.origin) {
        headers = new Headers(headers)
        for (const key of ["authorization", "cookie", "proxy-authorization"]) headers.delete(key)
      }
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === "POST")
      ) {
        method = "GET"
        headers.delete("content-length")
        headers.delete("content-type")
      }
      url = next
    }
  }
}
