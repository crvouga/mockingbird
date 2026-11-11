import type { AdminApiConfig, AdminConfig } from "./model.js"

export type ComposableAdminApi = AdminApiConfig & {
  fetch(request: Request): Promise<Response>
}

export type ComposedAdminRoutes = {
  /** What the shared UI mounts with: one entry per API, each behind `<prefix>/apis/<id>`. */
  config: AdminConfig
  /** The normalised mount prefix, `/__admin` by default. */
  prefix: string
  /** Forwards `<prefix>/apis/<id>/…` to that API unchanged. Everything else is a 404. */
  fetch(request: Request): Promise<Response>
}

/**
 * The routing half of `composeAdminApis`: the UI config and the forwarding fetch, without the
 * HTML document. This module never imports the prebuilt browser bundle, so a page that mounts
 * the UI from `@crvouga/mockingbird-admin-ui/browser` does not also carry it as a string.
 */
export const composeAdminRoutes = (
  apis: readonly ComposableAdminApi[],
  options: { brandsUrl: string; prefix?: string },
): ComposedAdminRoutes => {
  if (apis.length === 0) throw new RangeError("composeAdminApis needs at least one admin API")
  const ids = new Set<string>()
  for (const api of apis) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(api.id))
      throw new RangeError(`invalid admin API id ${JSON.stringify(api.id)}`)
    if (ids.has(api.id)) throw new RangeError(`duplicate admin API id ${api.id}`)
    ids.add(api.id)
  }
  const prefix = `/${(options.prefix ?? "/__admin").replace(/^\/+|\/+$/g, "")}`
  const first = apis[0] as ComposableAdminApi
  const config: AdminConfig = {
    service: first.service,
    adminPrefix: `${prefix}/apis/${first.id}`,
    adminKeyHeader: first.adminKeyHeader,
    standardRoutes: first.standardRoutes,
    brandsUrl: options.brandsUrl,
    apis: apis.map(({ fetch: _fetch, ...api }) => ({
      ...api,
      adminPrefix: `${prefix}/apis/${api.id}`,
    })),
  }
  return {
    config,
    prefix,
    async fetch(request) {
      const url = new URL(request.url)
      const root = `${prefix}/apis/`
      if (!url.pathname.startsWith(root)) return new Response("Not found", { status: 404 })
      const rest = url.pathname.slice(root.length)
      const slash = rest.indexOf("/")
      const id = slash < 0 ? rest : rest.slice(0, slash)
      const api = apis.find((candidate) => candidate.id === id)
      if (!api) return new Response("Not found", { status: 404 })
      url.pathname = `${api.adminPrefix.replace(/\/$/, "")}${slash < 0 ? "" : rest.slice(slash)}`
      return api.fetch(new Request(url, request))
    },
  }
}
