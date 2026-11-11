/**
 * The admin gateway: every emulator's admin API and the shared admin UI, on the harness's own
 * origin. The browser then needs one port and no CORS, however many emulators the fleet runs.
 *
 *   /admin/ui.js             the admin UI (defines `MockingbirdAdmin.mount(host, config)`)
 *   /admin/ui                the admin UI as a page of its own
 *   /admin/apis/<name>/…     that emulator's admin API, forwarded unchanged
 *
 * This module carries the prebuilt admin UI (about 1.3 MB), which is why the harness takes it as an
 * option instead of importing it: an app that embeds the harness in a browser does not pay for it.
 */
import {
  type AdminConfig,
  adminClientScript,
  type ComposableAdminApi,
  composeAdminApis,
} from "@crvouga/mockingbird-admin-ui"
import type { AdminTarget } from "./discovery.js"
import type { AdminGatewayFactory } from "./harness.js"

/** Where the admin UI reads each vendor's logo and links from, as every emulator's own admin does. */
export const ADMIN_BRANDS_URL = "https://mockingbird.chrisvouga.dev/brands.json"

const PREFIX = "/admin"
const KEY_HEADER = "x-mockingbird-admin-key"
/** Describe one hop, not the resource: never forwarded in either direction. */
const HOP_HEADERS = [
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "transfer-encoding",
]

let script: string | undefined
/** The admin UI bundle as a script file: it defines `MockingbirdAdmin` and mounts nothing. */
const adminScript = (): string => {
  script ??= adminClientScript()
  return script
}

/** Admin API ids are DNS-label shaped; emulator names from `services` can be anything. */
const idFor = (name: string, taken: Set<string>): string => {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56) || "emulator"
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  taken.add(id)
  return id
}

const failure = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { type: "mockingbird_notifications", message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

export type AdminGatewayOptions = {
  /** Default {@link ADMIN_BRANDS_URL}. */
  brandsUrl?: string
}

/**
 * Pass the result as the harness's `admin` option. `createServer` does so by default.
 *
 * A request that carries no admin key gets the harness's own (`adminKey` / `adminKeys`), so the
 * page works against a locked fleet without the viewer typing the key. Anyone who can reach the
 * harness can then change emulator state: keep it on a loopback or otherwise private address.
 */
export const adminGateway =
  (options: AdminGatewayOptions = {}): AdminGatewayFactory =>
  (context) => {
    const brandsUrl = options.brandsUrl ?? ADMIN_BRANDS_URL

    const forward =
      (target: AdminTarget) =>
      async (request: Request): Promise<Response> => {
        const from = new URL(request.url)
        const headers = new Headers(request.headers)
        for (const name of HOP_HEADERS) headers.delete(name)
        headers.delete("accept-encoding")
        if (!headers.has(KEY_HEADER))
          for (const [name, value] of Object.entries(context.headers(target.name)))
            headers.set(name, value)
        const hasBody = request.method !== "GET" && request.method !== "HEAD"
        try {
          const response = await target.fetch(
            new Request(new URL(`${from.pathname}${from.search}`, target.adminUrl), {
              method: request.method,
              headers,
              ...(hasBody ? { body: await request.arrayBuffer() } : {}),
              signal: request.signal,
            }),
          )
          const out = new Headers(response.headers)
          for (const name of HOP_HEADERS) out.delete(name)
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: out,
          })
        } catch (error) {
          return failure(
            502,
            `${target.name} is unreachable at ${target.adminUrl}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }

    type Composed = {
      key: string
      config: AdminConfig
      fetch(request: Request): Promise<Response>
    }
    let composed: Composed | null = null
    const compose = async (): Promise<Composed | null> => {
      const targets = await context.targets()
      if (targets.length === 0) return null
      const key = targets.map((t) => `${t.name}\u0000${t.target}\u0000${t.adminUrl}`).join("\n")
      if (composed?.key === key) return composed
      const taken = new Set<string>()
      const apis = targets.map(
        (target): ComposableAdminApi => ({
          id: idFor(target.name, taken),
          label: target.name === target.target ? target.name : `${target.name} (${target.target})`,
          service: target.target,
          adminPrefix: new URL(target.adminUrl).pathname.replace(/\/+$/, ""),
          adminKeyHeader: KEY_HEADER,
          standardRoutes: [],
          fetch: forward(target),
        }),
      )
      const first = apis[0] as ComposableAdminApi
      const routes = composeAdminApis(apis, { brandsUrl, prefix: PREFIX, title: context.title })
      composed = {
        key,
        config: {
          service: first.service,
          adminPrefix: `${PREFIX}/apis/${first.id}`,
          adminKeyHeader: KEY_HEADER,
          standardRoutes: [],
          brandsUrl,
          apis: apis.map(({ fetch: _fetch, ...api }) => ({
            ...api,
            adminPrefix: `${PREFIX}/apis/${api.id}`,
          })),
        },
        fetch: (request) => routes.fetch(request),
      }
      return composed
    }

    return {
      config: async () => (await compose())?.config ?? null,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === `${PREFIX}/ui.js`) {
          if (request.method !== "GET" && request.method !== "HEAD")
            return failure(405, "method not allowed")
          return new Response(adminScript(), {
            headers: {
              "content-type": "text/javascript; charset=utf-8",
              "cache-control": "no-store",
            },
          })
        }
        const current = await compose()
        if (!current) return failure(404, "the harness knows no emulators")
        return current.fetch(request)
      },
    }
  }
