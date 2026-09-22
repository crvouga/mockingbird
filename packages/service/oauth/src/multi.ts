import { type Clock, createClock } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { createRuntime, type OAuthRuntime, type OAuthRuntimeOptions } from "./runtime.js"
import type { Provider } from "./types.js"

export type OAuthMount = Omit<
  OAuthRuntimeOptions,
  "clock" | "mountPath" | "runtimeName" | "sqlite"
> & {
  /** Exact public path prefix, such as `/google`. */
  path: string
  provider: Provider
}

export type OAuthMultiRuntimeOptions = {
  mounts: OAuthMount[]
  clock?: Clock
  sqlite?: SqliteClient
  adminKey?: string
  seed?: number | string
}

export type OAuthMultiRuntime = {
  readonly name: "oauth"
  readonly clock: Clock
  readonly mounts: ReadonlyMap<string, OAuthRuntime>
  fetch(request: Request): Promise<Response>
  reset(namespace?: string): Promise<void>
}

const MOUNT_PATTERN = /^\/[A-Za-z0-9](?:[A-Za-z0-9._~-]*)(?:\/[A-Za-z0-9](?:[A-Za-z0-9._~-]*))*$/
const NS_PREFIX = /^\/ns\/([^/]+)(\/.*)?$/
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } })

const validateMounts = (mounts: OAuthMount[]) => {
  if (mounts.length === 0) throw new Error("at least one OAuth mount is required")
  const paths = new Set<string>()
  const issuers = new Set<string>()
  for (const mount of mounts) {
    if (!MOUNT_PATTERN.test(mount.path) || mount.path.includes("//"))
      throw new Error(`invalid OAuth mount path ${JSON.stringify(mount.path)}`)
    if (paths.has(mount.path)) throw new Error(`duplicate OAuth mount path ${mount.path}`)
    paths.add(mount.path)
    if (mount.issuer) {
      const normalized = mount.issuer.replace(/\/$/, "")
      if (issuers.has(normalized)) throw new Error(`duplicate OAuth issuer ${normalized}`)
      issuers.add(normalized)
    }
    const clientIds = new Set<string>()
    const keyIds = new Set<string>()
    for (const client of mount.clients ?? []) {
      if (clientIds.has(client.id))
        throw new Error(`duplicate client ID ${client.id} in OAuth mount ${mount.path}`)
      clientIds.add(client.id)
      if (client.apple?.keyId) {
        if (keyIds.has(client.apple.keyId))
          throw new Error(
            `duplicate Apple key ID ${client.apple.keyId} in OAuth mount ${mount.path}`,
          )
        keyIds.add(client.apple.keyId)
      }
    }
  }
}

const withoutMount = (request: Request, namespacePrefix: string, rest: string) => {
  const url = new URL(request.url)
  url.pathname = `${namespacePrefix}${rest || "/"}`
  return new Request(url, request)
}

/** Compose independent provider runtimes behind exact path mounts on one listener. */
export function createMultiRuntime(options: OAuthMultiRuntimeOptions): OAuthMultiRuntime {
  validateMounts(options.mounts)
  const clock = options.clock ?? createClock()
  const runtimes = new Map<string, OAuthRuntime>()
  for (const mount of options.mounts) {
    const { path, ...runtimeOptions } = mount
    const runtime = createRuntime({
      ...runtimeOptions,
      clock,
      ...(options.sqlite ? { sqlite: options.sqlite } : {}),
      ...((runtimeOptions.adminKey ?? options.adminKey)
        ? { adminKey: runtimeOptions.adminKey ?? options.adminKey }
        : {}),
      ...((runtimeOptions.seed ?? options.seed) !== undefined
        ? { seed: runtimeOptions.seed ?? options.seed }
        : {}),
      mountPath: path,
      runtimeName: `oauth@${path}`,
    })
    // Construction is normally lazy. Materialize every default instance so invalid clients,
    // accounts, issuers, or behavior fail before a server can begin listening.
    runtime.instance()
    runtimes.set(path, runtime)
  }

  const reset = async (namespace = "*") => {
    await Promise.all([...runtimes.values()].map((runtime) => runtime.reset(namespace)))
  }

  return {
    name: "oauth",
    clock,
    mounts: runtimes,
    reset,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/health") {
        const health = await Promise.all(
          [...runtimes.entries()].map(async ([path, runtime]) => [
            path,
            await (await runtime.fetch(new Request(new URL("/health", url), request))).json(),
          ]),
        )
        return json({ status: "ok", service: "oauth", mounts: Object.fromEntries(health) })
      }
      if (
        url.pathname.startsWith("/__admin") &&
        options.adminKey !== undefined &&
        request.headers.get("x-mockingbird-admin-key") !== options.adminKey
      )
        return json({ error: { type: "mockingbird_admin", message: "invalid admin key" } }, 401)
      if (url.pathname === "/__admin/mounts" && request.method === "GET")
        return json({
          mounts: options.mounts.map(({ path, provider, issuer }) => ({ path, provider, issuer })),
        })
      if (url.pathname === "/__admin/reset" && request.method === "POST") {
        const namespace =
          url.searchParams.get("all") === "1"
            ? "*"
            : (url.searchParams.get("namespace") ??
              request.headers.get("x-mockingbird-namespace") ??
              "default")
        await reset(namespace)
        return json({ status: "ok", mounts: [...runtimes.keys()], namespace })
      }
      if (url.pathname.startsWith("/__admin/")) {
        const selected = url.searchParams.get("mount")
        const runtime = selected && runtimes.get(selected)
        if (!runtime)
          return json({ error: { type: "mockingbird_admin", message: "mount is required" } }, 400)
        url.searchParams.delete("mount")
        return runtime.fetch(new Request(url, request))
      }

      const namespace = NS_PREFIX.exec(url.pathname)
      const namespacePrefix = namespace ? `/ns/${namespace[1]}` : ""
      const path = namespace ? (namespace[2] ?? "/") : url.pathname
      for (const [mount, runtime] of runtimes) {
        if (path !== mount && !path.startsWith(`${mount}/`)) continue
        return runtime.fetch(withoutMount(request, namespacePrefix, path.slice(mount.length)))
      }
      return json({ error: { type: "mockingbird_not_found", message: "unknown OAuth mount" } }, 404)
    },
  }
}
