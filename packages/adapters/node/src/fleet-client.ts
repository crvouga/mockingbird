import type { ProtectedArchive } from "./fleet-protection.js"
import { randomUUID } from "node:crypto"
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises"
import { canonical, type FleetArchive, validateArchive } from "./fleet-archive.js"
import type { EndpointManifest } from "./fleet-manifest.js"

export class FleetClientError extends Error {
  constructor(
    readonly status: number,
    readonly details: unknown,
  ) {
    super(`fleet control HTTP ${status}: ${canonical(details)}`)
  }
}
export type FleetClientOptions = {
  adminKey?: string
  namespace?: string
  timeoutMs?: number
  fetch?: typeof fetch
}
/** Supported control client: credentials are headers; base URL includes the discovered prefix. */
export class FleetClient {
  constructor(
    readonly base: string,
    private readonly options: FleetClientOptions = {},
  ) {}
  async request<T = Record<string, unknown>>(
    path: string,
    options: {
      method?: string
      body?: unknown
      namespace?: string
      idempotencyKey?: string
      signal?: AbortSignal
    } = {},
  ): Promise<T> {
    const url = new URL(`${this.base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`)
    if (url.username || url.password)
      throw new Error("fleet client URL must not contain credentials")
    url.searchParams.set("namespace", options.namespace ?? this.options.namespace ?? "default")
    const response = await (this.options.fetch ?? fetch)(url, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: {
        "content-type": "application/json",
        ...(this.options.adminKey ? { "x-mockingbird-admin-key": this.options.adminKey } : {}),
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: options.signal ?? AbortSignal.timeout(this.options.timeoutMs ?? 30000),
    })
    const data: unknown = await response.json()
    if (!response.ok) throw new FleetClientError(response.status, data)
    return data as T
  }
  discover() {
    return this.request<{
      version: number
      routes: { method: string; path: string }[]
      manifest: EndpointManifest
    }>("")
  }
  namespaces() {
    return this.request("namespaces")
  }
  createNamespace(namespace: string, baseline?: string) {
    return this.request(`namespaces/${encodeURIComponent(namespace)}`, {
      body: baseline ? { baseline } : {},
    })
  }
  deleteNamespace(namespace: string) {
    return this.request(`namespaces/${encodeURIComponent(namespace)}`, { method: "DELETE" })
  }
  reset(namespace: string, options: { services?: string[]; idempotencyKey?: string } = {}) {
    return this.request(`namespaces/${encodeURIComponent(namespace)}/reset`, {
      body: options.services ? { services: options.services } : {},
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    })
  }
  snapshot(
    namespace: string,
    options: { label?: string; services?: string[]; idempotencyKey?: string } = {},
  ) {
    const { idempotencyKey, ...body } = options
    return this.request<{ id: string }>(`namespaces/${encodeURIComponent(namespace)}/snapshots`, {
      body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    })
  }
  restore(namespace: string, id: string, idempotencyKey?: string) {
    return this.request(
      `namespaces/${encodeURIComponent(namespace)}/snapshots/${encodeURIComponent(id)}/restore`,
      { body: {}, ...(idempotencyKey ? { idempotencyKey } : {}) },
    )
  }
  exportArchive(namespace?: string, allNamespaces = false) {
    return this.request<FleetArchive>("archives/export", {
      body: { allNamespaces },
      ...(namespace ? { namespace } : {}),
    })
  }
  exportProtectedArchive(namespace?: string, allNamespaces = false) {
    return this.request<ProtectedArchive>("archives/export", { body: { allNamespaces }, ...(namespace ? { namespace } : {}) })
  }
  importArchive(archive: FleetArchive | ProtectedArchive, namespace?: string) {
    if (archive.format !== "mockingbird.jwe/v1") validateArchive(archive)
    return this.request("archives/import", {
      body: { archive, ...(namespace ? { namespace } : {}) },
    })
  }
  operation(id: string) {
    return this.request(`operations/${encodeURIComponent(id)}`)
  }
}

export type ConnectionManifest = {
  version: 1
  services: Record<string, { url: string; namespaces?: Record<string, string> }>
}
export type ConnectionMapping = Record<string, { service: string }>
/** Explicit variable mappings, with namespace-specific URLs taken from current discovery. */
export function renderConnections(
  manifest: EndpointManifest,
  privateManifest: ConnectionManifest,
  namespace: string,
  mapping: ConnectionMapping,
): Record<string, string> {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(namespace)) throw new Error("invalid namespace")
  const result: Record<string, string> = {}
  for (const [variable, entry] of Object.entries(mapping)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable))
      throw new Error(`invalid variable name ${variable}`)
    const child = manifest.services[entry.service],
      secret = privateManifest.services[entry.service]
    if (!child || !secret) throw new Error(`missing service mapping ${entry.service}`)
    if (child.protocol === "http") {
      const template = child.namespaces.path
      if (typeof template !== "string")
        throw new Error(`missing HTTP namespace mapping ${entry.service}`)
      result[variable] = new URL(
        template.replace("{name}", encodeURIComponent(namespace)),
        secret.url,
      ).href
    } else {
      const endpoint = secret.namespaces?.[namespace]
      if (!endpoint) throw new Error(`missing namespace mapping ${namespace}/${entry.service}`)
      result[variable] = endpoint
    }
  }
  return result
}
export async function writeConnections(
  path: string,
  values: Record<string, string>,
  format: "json" | "dotenv" = "json",
) {
  const temp = `${path}.${randomUUID()}.tmp`
  const text =
    format === "json"
      ? `${JSON.stringify(values, null, 2)}\n`
      : `${Object.entries(values)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join("\n")}\n`
  try {
    await writeFile(temp, text, { mode: 0o600, flag: "wx" })
    await chmod(temp, 0o600)
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}
export const readConnectionManifest = async (path: string): Promise<ConnectionManifest> =>
  JSON.parse(await readFile(path, "utf8")) as ConnectionManifest
