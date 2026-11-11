/**
 * Where the emulators are. The harness reads the same fleet the application uses: the live fleet
 * controller (`adminBase`), the fleet's ready manifest, or explicit URLs and in-process runtimes.
 */
import { SERVICE_KINDS, type ServiceKind } from "./model.js"

export type FetchLike = (request: Request) => Response | Promise<Response>

/** A service emulator: its base URL, an `{ url, adminUrl?, service? }` entry, or an in-process runtime. */
export type ServiceInput =
  | string
  | { url: string; adminUrl?: string; service?: ServiceKind }
  | { fetch: FetchLike; service?: ServiceKind; adminPrefix?: string }

/** The subset of a fleet ready manifest (`--ready-file`) the harness reads. */
export type FleetManifest = {
  adminBase?: string
  services: Record<
    string,
    { protocol?: string; url?: string; adminUrl?: string; target?: string } | undefined
  >
}

export type Endpoint = {
  /** The fleet entry name, e.g. `twilio`, or an alias such as `push`. */
  name: string
  /** Null until the emulator's health route has told us what it is. */
  service: ServiceKind | null
  /** Absolute admin prefix, e.g. `http://127.0.0.1:8798/__admin`. */
  adminUrl: string
  fetch: FetchLike
}

export const asServiceKind = (value: unknown): ServiceKind | null =>
  typeof value === "string" && (SERVICE_KINDS as readonly string[]).includes(value)
    ? (value as ServiceKind)
    : null

const trimSlash = (url: string) => url.replace(/\/+$/, "")

export const endpointsFromServices = (
  services: Record<string, ServiceInput>,
  fetchImpl: FetchLike,
): Endpoint[] =>
  Object.entries(services).map(([name, input]) => {
    if (typeof input === "string")
      return {
        name,
        service: asServiceKind(name),
        adminUrl: `${trimSlash(input)}/__admin`,
        fetch: fetchImpl,
      }
    if ("fetch" in input)
      return {
        name,
        service: input.service ?? asServiceKind(name),
        adminUrl: `http://${name}.mockingbird.local${input.adminPrefix ?? "/__admin"}`,
        fetch: input.fetch,
      }
    return {
      name,
      service: input.service ?? asServiceKind(name),
      adminUrl: input.adminUrl ? trimSlash(input.adminUrl) : `${trimSlash(input.url)}/__admin`,
      fetch: fetchImpl,
    }
  })

export const endpointsFromManifest = (
  manifest: FleetManifest,
  fetchImpl: FetchLike,
  targets: Record<string, string | undefined> = {},
): Endpoint[] =>
  Object.entries(manifest.services ?? {}).flatMap(([name, entry]): Endpoint[] => {
    if (!entry || (entry.protocol && entry.protocol !== "http") || !entry.url) return []
    const service = asServiceKind(targets[name] ?? entry.target ?? name)
    // A target the fleet named that the harness cannot read (stripe, postgres, …) is skipped.
    if (!service && (targets[name] ?? entry.target)) return []
    return [
      {
        name,
        service,
        adminUrl: entry.adminUrl ? trimSlash(entry.adminUrl) : `${trimSlash(entry.url)}/__admin`,
        fetch: fetchImpl,
      },
    ]
  })

export type FleetDiscovery = {
  endpoints: Endpoint[]
  namespaces: string[]
}

/** Ask a running fleet controller for its manifest, each entry's target, and its namespaces. */
export const discoverFleet = async (
  adminBase: string,
  fetchImpl: FetchLike,
  headers: Record<string, string>,
): Promise<FleetDiscovery> => {
  const base = trimSlash(adminBase)
  const get = async (path: string) => {
    const response = await fetchImpl(new Request(`${base}${path}`, { headers }))
    if (!response.ok) throw new Error(`fleet ${base}${path}: HTTP ${response.status}`)
    return (await response.json()) as Record<string, unknown>
  }
  const [root, namespaces] = await Promise.all([
    get(""),
    get("/namespaces").catch((): Record<string, unknown> => ({})),
  ])
  const manifest = root.manifest as FleetManifest | undefined
  if (!manifest?.services) throw new Error(`fleet ${base}: discovery has no manifest`)
  const described = (root.services ?? {}) as Record<string, { target?: string } | undefined>
  const targets = Object.fromEntries(
    Object.entries(described).map(([name, entry]) => [name, entry?.target]),
  )
  const names = Array.isArray(namespaces.namespaces)
    ? (namespaces.namespaces as { namespace?: unknown }[])
        .map((n) => n.namespace)
        .filter((n): n is string => typeof n === "string")
    : []
  return { endpoints: endpointsFromManifest(manifest, fetchImpl, targets), namespaces: names }
}
