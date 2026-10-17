import type { ConfigService, MockingbirdConfig } from "./cli.js"
import type { ConnectionManifest } from "./fleet-client.js"

export const ingressSupport = {
  stripe: {
    publicOrigin: true,
    pathPrefix: true,
    namespaces: "path-or-header",
    streaming: true,
    signing: "vendor request signing is not used; webhook signatures remain payload based",
  },
  cognito: {
    publicOrigin: true,
    pathPrefix: true,
    namespaces: "path-or-header",
    streaming: true,
    signing:
      "JWT issuer and JWKS use the configured public namespace; SigV4 verification is not modelled",
  },
  medplum: {
    publicOrigin: true,
    pathPrefix: true,
    namespaces: "path-or-header",
    streaming: true,
    signing: "FHIR, OAuth and storage URLs use the configured public namespace",
  },
  other: {
    publicOrigin: false,
    reason:
      "host/path-sensitive signing and hosted URL rewriting are not certified; use a direct endpoint",
  },
} as const

export function supportsPublicIngress(
  service: string,
): service is "stripe" | "cognito" | "medplum" {
  return service === "stripe" || service === "cognito" || service === "medplum"
}

/** Fixed configuration is the only authority for generated/advertised origins. */
export function advertisedHttpBase(entry: ConfigService): string | undefined {
  if (entry.publicPath !== undefined && !entry.publicOrigin)
    throw new Error("publicPath requires publicOrigin")
  if (!entry.publicOrigin) return undefined
  const url = new URL(entry.publicOrigin)
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("publicOrigin must be an HTTP(S) origin without credentials or a path")
  const prefix = entry.publicPath ?? ""
  if (prefix && (!/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(prefix) || prefix.endsWith("/")))
    throw new Error("publicPath must be a canonical path prefix without a trailing slash")
  return `${url.origin}${prefix}`
}

/** Fetch-based reference ingress. TLS/DNS are supplied by the caller. Bodies stream both ways. */
export function createFleetIngress(
  config: MockingbirdConfig,
  manifest: ConnectionManifest,
  transport: typeof fetch = fetch,
) {
  const routes = Object.entries(config.services)
    .flatMap(([service, entry]) => {
      const base = advertisedHttpBase(entry)
      if (!base) return []
      if (!supportsPublicIngress(entry.target ?? service))
        throw new Error(
          `public ingress unsupported for ${entry.target ?? service}; host/path-sensitive signatures require a direct endpoint`,
        )
      const privateEndpoint = manifest.services[service]
      if (!privateEndpoint || (entry.protocol && entry.protocol !== "http"))
        throw new Error(`missing HTTP ingress participant ${service}`)
      const publicUrl = new URL(base)
      return [
        {
          service,
          entry,
          origin: publicUrl.origin,
          prefix: publicUrl.pathname === "/" ? "" : publicUrl.pathname,
          privateUrl: new URL(privateEndpoint.url),
        },
      ]
    })
    .sort((a, b) => b.prefix.length - a.prefix.length)
  const keys = routes.map((r) => `${r.origin}${r.prefix}`)
  if (new Set(keys).size !== keys.length) throw new Error("ambiguous public ingress mapping")
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const route = routes.find(
      (r) =>
        url.origin === r.origin &&
        (url.pathname === r.prefix || url.pathname.startsWith(`${r.prefix}/`)),
    )
    if (!route) return new Response("public ingress route not found", { status: 404 })
    if (
      (route.entry.target ?? route.service) === "cognito" &&
      request.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256")
    )
      return new Response("SigV4 requests require a direct endpoint", { status: 403 })
    const path = url.pathname.slice(route.prefix.length) || "/"
    const adminPrefix = route.entry.adminPrefix ?? config.adminPrefix ?? "/__admin"
    // Namespace path carriers select vendor state. All other administration stays private.
    if (
      (path === adminPrefix || path.startsWith(`${adminPrefix}/`)) &&
      !path.startsWith(`${adminPrefix}/ns/`)
    )
      return new Response("administration is private", { status: 403 })
    if (path.startsWith(`${adminPrefix}/ns/`)) {
      const tail = path.slice(`${adminPrefix}/ns/`.length),
        slash = tail.indexOf("/")
      if (
        slash < 1 ||
        tail.slice(slash) === adminPrefix ||
        tail.slice(slash).startsWith(`${adminPrefix}/`)
      )
        return new Response("administration is private", { status: 403 })
    }
    const destination = new URL(route.privateUrl)
    destination.pathname = path
    destination.search = url.search
    const headers = new Headers(request.headers)
    for (const name of [...headers.keys()])
      if (
        name === "host" ||
        name === "forwarded" ||
        name.startsWith("x-forwarded-") ||
        name === "x-mockingbird-admin-key" ||
        name === "x-mockingbird-initializer"
      )
        headers.delete(name)
    return transport(
      new Request(destination, {
        method: request.method,
        headers,
        body: request.body,
        signal: request.signal,
        redirect: "manual",
        duplex: "half",
      } as RequestInit),
    )
  }
}
