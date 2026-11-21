import { digestPreviewBytes, type PreviewDownload } from "./artifacts.js"
import { type PullRequestFacts, selectPreviewAction } from "./lifecycle.js"

export type PreviewAssetFile = { path: string; bytes: Uint8Array; contentType: string }
export type CloudflarePreview = { id: string; name: string; updatedAt: string; urls: string[] }
type Json = Record<string, unknown>
const object = (value: unknown): Json => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Cloudflare preview response")
  return value as Json
}
const control = (value: string) => [...value].some((character) => character.charCodeAt(0) < 32)
const identifier = (value: string) => {
  if (!value || value === "." || value === ".." || control(value))
    throw new Error("Invalid Cloudflare preview identifier")
  return encodeURIComponent(value)
}
const preview = (value: unknown): CloudflarePreview => {
  const item = object(value)
  const updatedAt =
    typeof item.updated_on === "string"
      ? item.updated_on
      : typeof item.created_on === "string"
        ? item.created_on
        : undefined
  if (typeof item.id !== "string" || typeof item.name !== "string" || updatedAt === undefined)
    throw new Error("Invalid Cloudflare preview response")
  return {
    id: item.id,
    name: item.name,
    updatedAt,
    urls: Array.isArray(item.urls)
      ? item.urls.filter((url): url is string => typeof url === "string")
      : [],
  }
}
const base64 = (bytes: Uint8Array) => {
  let result = ""
  for (let offset = 0; offset < bytes.length; offset += 8192)
    result += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(result)
}
/** Claims of a JWT, or `{}` when it is not one. The signature is Cloudflare's to check. */
const claims = (jwt: string): Json => {
  try {
    const payload = (jwt.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/")
    const binary = atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "="))
    const decoded = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
    return object(JSON.parse(decoded))
  } catch {
    return {}
  }
}
type Part = { name: string; filename?: string; type?: string; body: string }
/**
 * A multipart/form-data body written by hand, so each part's Content-Type is exactly what is
 * given on every runtime (Bun's encoder turns `text/plain` into `text/plain;charset=utf-8`).
 */
const multipart = (parts: Part[]): RequestInit => {
  let boundary = ""
  do boundary = `mockingbird-preview-${crypto.randomUUID()}`
  while (parts.some((part) => part.body.includes(boundary)))
  let body = ""
  for (const part of parts) {
    const filename = part.filename === undefined ? "" : `; filename="${part.filename}"`
    const type = part.type === undefined ? "" : `Content-Type: ${part.type}\r\n`
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${filename}\r\n${type}\r\n${part.body}\r\n`
  }
  return {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: `${body}--${boundary}--\r\n`,
  }
}
/** Runs `run` over `items` with at most `limit` in flight; stops taking new items after a failure. */
const pool = async <T>(items: T[], limit: number, run: (item: T) => Promise<void>) => {
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++] as T
      try {
        await run(item)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i
const hostLabel = (value: string, what: string) => {
  if (!LABEL.test(value)) throw new Error(`Invalid ${what}`)
  return value.toLowerCase()
}
const hostName = (value: string, what: string) => {
  if (!HOST.test(value)) throw new Error(`Invalid ${what}`)
  return value.toLowerCase()
}

/**
 * The origin of a named Preview on workers.dev: `https://<previewName>-<workerName>.<subdomain>.workers.dev`.
 * `subdomain` is the account's workers.dev subdomain (see `subdomain()`), without `.workers.dev`.
 * Throws when the first label would exceed 63 characters, which Cloudflare truncates.
 */
export function previewOrigin(input: {
  previewName: string
  workerName: string
  subdomain: string
}) {
  const label = `${hostLabel(input.previewName, "preview name")}-${hostLabel(input.workerName, "Worker name")}`
  if (label.length > 63)
    throw new Error(
      `Preview host label "${label}" exceeds 63 characters; Cloudflare would truncate it`,
    )
  return `https://${label}.${hostName(input.subdomain, "workers.dev subdomain")}.workers.dev`
}
/** The origin of a named Preview on a custom domain with Previews enabled: `https://<previewName>.<host>`. */
export function customPreviewOrigin(input: { previewName: string; host: string }) {
  return `https://${hostLabel(input.previewName, "preview name")}.${hostName(input.host, "host")}`
}
/**
 * Whether `origin` is exactly an https origin of the named Preview, on the account's workers.dev
 * (`subdomain`) or on the custom domain `host`. With `workerName` the workers.dev host must be that
 * Worker's; without it, any Worker on the account's subdomain is accepted. Never throws.
 */
export function isPreviewOriginOf(input: {
  origin: string
  previewName: string
  workerName?: string
  subdomain?: string | null
  host?: string | null
}) {
  let url: URL
  try {
    url = new URL(input.origin)
  } catch {
    return false
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    input.origin.replace(/\/$/, "") !== url.origin ||
    !LABEL.test(input.previewName)
  )
    return false
  const name = input.previewName.toLowerCase()
  const hostname = url.hostname
  if (input.host && HOST.test(input.host) && hostname === `${name}.${input.host.toLowerCase()}`)
    return true
  if (!input.subdomain || !HOST.test(input.subdomain)) return false
  const suffix = `.${input.subdomain.toLowerCase()}.workers.dev`
  if (!hostname.endsWith(suffix)) return false
  const label = hostname.slice(0, -suffix.length)
  if (input.workerName !== undefined) {
    if (!LABEL.test(input.workerName)) return false
    return label === `${name}-${input.workerName.toLowerCase()}`
  }
  return LABEL.test(label) && label.startsWith(`${name}-`) && label.length > name.length + 1
}

/** Uses named Worker Previews only. Never calls the production script/deployment update endpoint. */
export function createCloudflarePreviews(options: {
  accountId: string
  workerName: string
  token: string
  fetch?: PreviewDownload
  /** Asset upload requests in flight at once. Default 3 buckets (wrangler's), or the session's per-file concurrency. */
  uploadConcurrency?: number
}) {
  const account = identifier(options.accountId)
  const worker = identifier(options.workerName)
  if (!options.token) throw new Error("Cloudflare preview token is required")
  if (
    options.uploadConcurrency !== undefined &&
    (!Number.isInteger(options.uploadConcurrency) || options.uploadConcurrency < 1)
  )
    throw new Error("Cloudflare preview uploadConcurrency must be a positive integer")
  const parent = `/accounts/${account}/workers/workers/${worker}`
  const script = `/accounts/${account}/workers/scripts/${worker}`
  const base = `${parent}/previews`
  const api = async (
    operation: string,
    path: string,
    init: RequestInit = {},
    token = options.token,
    missing = false,
  ): Promise<Json | undefined> => {
    let response: Response
    try {
      response = await (options.fetch ?? fetch)(`https://api.cloudflare.com/client/v4${path}`, {
        ...init,
        redirect: "error",
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          Authorization: `Bearer ${token}`,
        },
      })
    } catch {
      throw new Error(`Cloudflare preview ${operation} failed (network)`)
    }
    if (missing && response.status === 404) return undefined
    if (!response.ok)
      throw new Error(`Cloudflare preview ${operation} failed (HTTP ${response.status})`)
    if (response.status === 204) return { success: true, result: null }
    let parsed: Json
    try {
      parsed = object(await response.json())
    } catch {
      throw new Error(`Cloudflare preview ${operation} returned invalid JSON`)
    }
    if (parsed.success !== true) throw new Error(`Cloudflare preview ${operation} was refused`)
    return parsed
  }
  const json = (body: unknown, method = "POST", headers: Record<string, string> = {}) => ({
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  const remove = async (name: string) => {
    await api("delete", `${base}/${identifier(name)}`, { method: "DELETE" }, options.token, true)
  }
  /** One named Preview, or `null` when Cloudflare answers 404. Any other failure rejects. */
  const get = async (name: string): Promise<CloudflarePreview | null> => {
    const found = await api("get", `${base}/${identifier(name)}`, {}, options.token, true)
    return found ? preview(found.result) : null
  }
  const list = async () => {
    const all: CloudflarePreview[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let page = 1; page <= 1000; page++) {
      const query = cursor
        ? `cursor=${encodeURIComponent(cursor)}&per_page=100`
        : `page=${page}&per_page=100`
      const response = await api("list", `${base}?${query}`, {}, options.token, page === 1)
      if (!response) {
        // A 404 before the parent Worker exists means no Previews; a 404 for a Worker that exists does not.
        const exists = await api("list", parent, {}, options.token, true)
        if (exists) throw new Error("Cloudflare preview list failed (HTTP 404)")
        return all
      }
      if (!Array.isArray(response.result))
        throw new Error("Cloudflare preview list returned invalid results")
      const results = response.result.map(preview)
      for (const item of results) {
        if (seen.has(item.id)) throw new Error("Cloudflare preview list repeated a page")
        seen.add(item.id)
        all.push(item)
      }
      const info = response.result_info ? object(response.result_info) : undefined
      if (typeof info?.cursor === "string") {
        if (!info.cursor || results.length === 0) return all
        cursor = info.cursor
      } else if (cursor) return all
      else if (typeof info?.total_pages === "number") {
        if (page >= info.total_pages) return all
      } else if (results.length < 100) return all
    }
    throw new Error("Cloudflare preview list exceeded pagination limit")
  }
  /** The account's workers.dev subdomain (without `.workers.dev`). Rejects on any failure. */
  const subdomain = async () => {
    const response = await api("subdomain", `/accounts/${account}/workers/subdomain`)
    const name = object(response?.result).subdomain
    if (typeof name !== "string" || !HOST.test(name))
      throw new Error("Invalid Cloudflare workers.dev subdomain response")
    return name
  }
  const settingsDate = { "cloudflare-workers-script-api-date": "2025-08-01" }
  /**
   * Has the parent Worker serve its Previews without deploying it. With `host` null, turns on
   * `previews_enabled` for workers.dev (Preview URLs), keeping the Worker's own workers.dev
   * `enabled` as it was, and writes nothing when it is already on. With a host, attaches that
   * custom domain to the Worker with `previews_enabled: true`, replacing the Worker's set of custom
   * domains (`override_scope`), as `wrangler deploy` does with its configured routes.
   */
  const servePreviews = async (host: string | null): Promise<{ changed: boolean }> => {
    if (host !== null) {
      await api(
        "serve previews",
        `${script}/domains/records`,
        json(
          {
            override_scope: true,
            override_existing_origin: true,
            override_existing_dns_record: true,
            origins: [{ hostname: hostName(host, "host"), previews_enabled: true }],
          },
          "PUT",
          settingsDate,
        ),
      )
      return { changed: true }
    }
    const current = object(
      (await api("serve previews", `${script}/subdomain`, { headers: settingsDate }))?.result,
    )
    if (current.previews_enabled === true) return { changed: false }
    await api(
      "serve previews",
      `${script}/subdomain`,
      json({ enabled: current.enabled === true, previews_enabled: true }, "POST", settingsDate),
    )
    return { changed: true }
  }
  const deploy = async (input: {
    name: string
    commit: string
    files: PreviewAssetFile[]
    currentPullRequest: () => Promise<PullRequestFacts>
    headers?: string
    compatibilityDate?: string
    htmlHandling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none"
    notFoundHandling?: "none" | "404-page" | "single-page-application"
  }) => {
    const name = identifier(input.name)
    const current = async () => selectPreviewAction(await input.currentPullRequest(), input.commit)
    const initial = await current()
    if (initial !== "deploy") {
      if (initial === "remove") await remove(input.name)
      return { action: initial }
    }
    const manifest: Record<string, { hash: string; size: number }> = {}
    const blobs = new Map<string, PreviewAssetFile>()
    for (const file of input.files) {
      if (
        !file.path.startsWith("/") ||
        file.path.includes("\\") ||
        file.path.split("/").some((part) => part === "." || part === "..") ||
        control(file.path) ||
        !file.contentType ||
        control(file.contentType) ||
        manifest[file.path]
      )
        throw new Error("Invalid or duplicate preview asset path")
      const type = new TextEncoder().encode(file.contentType)
      const identity = new Uint8Array(file.bytes.length + type.length + 1)
      identity.set(file.bytes)
      identity.set(type, file.bytes.length + 1)
      const hash = (await digestPreviewBytes(identity)).slice(0, 32)
      manifest[file.path] = { hash, size: file.bytes.length }
      blobs.set(hash, file)
    }
    const configuration = {
      compatibility_date: input.compatibilityDate ?? "2026-01-01",
      assets: {
        html_handling: input.htmlHandling ?? "auto-trailing-slash",
        not_found_handling: input.notFoundHandling ?? "none",
      },
    }
    const tag = await digestPreviewBytes(
      new TextEncoder().encode(
        JSON.stringify([
          input.commit,
          Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)),
          input.headers ?? "",
          configuration,
        ]),
      ),
    )
    // The Preview lookup does not depend on the upload, so both run at once.
    const lookup = async () => {
      let found = await api("get", `${base}/${name}`, {}, options.token, true)
      if (!found)
        found = await api("create", `${base}?ignore_base_config=true`, json({ name: input.name }))
      if (!found) throw new Error("Cloudflare preview creation failed")
      const resource = preview(found.result)
      const target = `${base}/${identifier(resource.id)}/deployments`
      const latest = await api("get latest deployment", `${target}/latest`, {}, options.token, true)
      let unchanged = false
      if (latest) {
        const deployment = object(latest.result)
        const annotations = deployment.annotations ? object(deployment.annotations) : {}
        unchanged =
          annotations["workers/tag"] === tag && annotations["workers/commit_sha"] === input.commit
      }
      return { resource, target, unchanged }
    }
    const upload = async () => {
      const session = await api(
        "asset session",
        `${script}/assets-upload-session`,
        json({ manifest }),
      )
      const started = object(session?.result)
      if (typeof started.jwt !== "string" || !Array.isArray(started.buckets))
        throw new Error("Invalid Cloudflare asset upload session")
      const jwt = started.jwt
      const buckets = started.buckets.map((bucket) => {
        if (
          !Array.isArray(bucket) ||
          bucket.some((hash) => typeof hash !== "string" || !blobs.has(hash))
        )
          throw new Error("Cloudflare requested an unknown preview asset")
        return bucket as string[]
      })
      if (buckets.flat().length === 0) return jwt
      const sessionClaims = claims(jwt)
      // wrangler: a session JWT with `wrangler_single_asset_uploads: true` takes one raw upload per asset.
      const single = sessionClaims.wrangler_single_asset_uploads === true
      const perFile = Number(sessionClaims.edge_kv_upload_concurrency)
      const concurrency =
        options.uploadConcurrency ?? (single ? (perFile > 0 ? Math.floor(perFile) : 50) : 3)
      let completion: string | undefined
      const send = async (operation: string, path: string, init: RequestInit) => {
        const result = await api(operation, path, init, jwt)
        const body = result?.result ? object(result.result) : {}
        if (typeof body.jwt === "string" && body.jwt) completion = body.jwt
      }
      if (single)
        await pool(buckets.flat(), concurrency, async (hash) => {
          const file = blobs.get(hash) as PreviewAssetFile
          await send("asset upload", `/accounts/${account}/workers/assets/upload/${hash}`, {
            method: "POST",
            headers: { "content-type": file.contentType },
            body: new Uint8Array(file.bytes),
          })
        })
      else
        await pool(buckets, concurrency, async (bucket) => {
          const form = multipart(
            bucket.map((hash) => {
              const file = blobs.get(hash) as PreviewAssetFile
              return {
                name: hash,
                filename: hash,
                type: file.contentType,
                body: base64(file.bytes),
              }
            }),
          )
          await send("asset upload", `/accounts/${account}/workers/assets/upload?base64=true`, form)
        })
      if (!completion) throw new Error("Cloudflare asset upload did not complete")
      return completion
    }
    const [found, completion] = await Promise.all([lookup(), upload()])
    const { resource, target } = found
    if (found.unchanged) return { action: "unchanged", preview: resource }
    const final = await current()
    if (final !== "deploy") {
      if (final === "remove") await remove(input.name)
      return { action: final }
    }
    const metadata = JSON.stringify({
      compatibility_date: configuration.compatibility_date,
      assets: { jwt: completion, config: configuration.assets },
      env: {},
      annotations: { "workers/commit_sha": input.commit, "workers/tag": tag },
    })
    const deployed = await api(
      "deploy",
      target,
      multipart([
        { name: "metadata", body: metadata },
        ...(input.headers === undefined
          ? []
          : [{ name: "files", filename: "_headers", type: "text/plain", body: input.headers }]),
      ]),
    )
    const deployment = object(deployed?.result)
    if (typeof deployment.id !== "string") throw new Error("Invalid Cloudflare deployment response")
    return { action: "deployed", preview: resource, deploymentId: deployment.id }
  }
  return { deploy, get, list, remove, servePreviews, subdomain }
}
