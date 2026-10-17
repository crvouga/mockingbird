import { randomUUID } from "node:crypto"
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises"
import { canonical, type FleetArchive, validateArchive } from "./fleet-archive.js"
import type { EndpointManifest } from "./fleet-manifest.js"
import type { ProtectedArchive } from "./fleet-protection.js"

export class FleetClientError extends Error {
  constructor(
    readonly status: number,
    readonly details: unknown,
  ) {
    super(`fleet control HTTP ${status}: ${canonical(details)}`)
  }
}
export class FleetClientResponseError extends FleetClientError {
  constructor(
    readonly code: "redirect" | "response_too_large" | "invalid_json",
    status: number,
    origin?: string,
  ) {
    super(status, { code, body: "omitted", ...(origin ? { origin } : {}) })
    this.name = "FleetClientResponseError"
  }
}

export type FleetClientOptions = {
  adminKey?: string
  namespace?: string
  timeoutMs?: number
  /** Custom adapters must honor redirect: manual and the supplied abort signal. */
  fetch?: typeof fetch
  /** Decoded response byte limit; archives can explicitly select a larger limit. Default 64 MiB. */
  maxResponseBytes?: number
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
      maxResponseBytes?: number
    } = {},
  ): Promise<T> {
    const url = new URL(`${this.base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`)
    if (url.username || url.password)
      throw new Error("fleet client URL must not contain credentials")
    url.searchParams.set("namespace", options.namespace ?? this.options.namespace ?? "default")
    const limit = options.maxResponseBytes ?? this.options.maxResponseBytes ?? 64 * 1024 * 1024
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid response byte limit")
    const deadline = AbortSignal.timeout(this.options.timeoutMs ?? 30000)
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
    signal.throwIfAborted()
    const response = await (this.options.fetch ?? fetch)(url, {
      redirect: "manual",
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: {
        "content-type": "application/json",
        ...(this.options.adminKey ? { "x-mockingbird-admin-key": this.options.adminKey } : {}),
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal,
    })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      // Never expose Location: it may contain credentials or sensitive query parameters.
      throw new FleetClientResponseError("redirect", response.status, url.origin)
    }
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel()
      throw new FleetClientResponseError("response_too_large", response.status)
    }
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    const abort = () => {
      void reader?.cancel(signal.reason).catch(() => {})
    }
    signal.addEventListener("abort", abort, { once: true })
    try {
      if (reader)
        while (true) {
          signal.throwIfAborted()
          const { done, value } = await reader.read()
          signal.throwIfAborted()
          if (done) break
          size += value.byteLength
          if (size > limit) {
            await reader.cancel()
            throw new FleetClientResponseError("response_too_large", response.status)
          }
          chunks.push(value)
        }
    } finally {
      signal.removeEventListener("abort", abort)
      if (signal.aborted) await reader?.cancel(signal.reason).catch(() => {})
      reader?.releaseLock()
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const text = new TextDecoder().decode(bytes)
    let data: unknown
    try {
      data = text.length ? JSON.parse(text) : undefined
    } catch {
      if (response.ok) throw new FleetClientResponseError("invalid_json", response.status)
    }
    if (!response.ok) {
      // Only machine error identifiers are retained. Raw bodies, messages and excerpts
      // are omitted because proxies and remote errors may contain secrets.
      const error =
        data && typeof data === "object" ? (data as { error?: unknown }).error : undefined
      const detail: Record<string, string> = { body: "omitted" }
      if (error && typeof error === "object")
        for (const key of ["type", "code"] as const) {
          const value = (error as Record<string, unknown>)[key]
          if (typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value))
            detail[key] = value
        }
      throw new FleetClientError(response.status, detail)
    }
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
    return this.request<ProtectedArchive>("archives/export", {
      body: { allNamespaces },
      ...(namespace ? { namespace } : {}),
    })
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
export type ConnectionField =
  | "url"
  | "hostname"
  | "port"
  | "username"
  | "password"
  | "pathname"
  | "database"
export type ConnectionMapping = Record<
  string,
  { service: string; field?: ConnectionField; fallback?: string }
>
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
    let endpoint: string
    if (child.protocol === "http") {
      const template = child.namespaces.path
      if (typeof template !== "string")
        throw new Error(`missing HTTP namespace mapping ${entry.service}`)
      endpoint = new URL(template.replace("{name}", encodeURIComponent(namespace)), secret.url).href
    } else {
      const selected = secret.namespaces?.[namespace]
      if (!selected) throw new Error(`missing namespace mapping ${namespace}/${entry.service}`)
      endpoint = selected
    }
    const url = new URL(endpoint)
    const field = entry.field ?? "url"
    let value: string
    switch (field) {
      case "url":
        value = endpoint
        break
      case "hostname":
        value = url.hostname.replace(/^\[|\]$/g, "")
        break
      case "port":
        value = url.port
        break
      case "username":
        value = decodeURIComponent(url.username)
        break
      case "password":
        value = decodeURIComponent(url.password)
        break
      case "pathname":
        value = decodeURIComponent(url.pathname)
        break
      case "database":
        value = decodeURIComponent(url.pathname.replace(/^\//, ""))
        break
      default:
        throw new Error("unsupported connection field")
    }
    if (!value) {
      if (typeof entry.fallback !== "string")
        throw new Error(`missing connection component ${field}`)
      value = entry.fallback
    }
    result[variable] = value
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
