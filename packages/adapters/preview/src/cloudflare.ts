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
const identifier = (value: string) => {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("Invalid Cloudflare preview identifier")
  return encodeURIComponent(value)
}
const preview = (value: unknown): CloudflarePreview => {
  const item = object(value)
  if (
    typeof item.id !== "string" ||
    typeof item.name !== "string" ||
    typeof item.updated_on !== "string"
  )
    throw new Error("Invalid Cloudflare preview response")
  return {
    id: item.id,
    name: item.name,
    updatedAt: item.updated_on,
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

/** Uses named Worker Previews only. Never calls the production script/deployment update endpoint. */
export function createCloudflarePreviews(options: {
  accountId: string
  workerName: string
  token: string
  fetch?: PreviewDownload
}) {
  const account = identifier(options.accountId)
  const worker = identifier(options.workerName)
  if (!options.token) throw new Error("Cloudflare preview token is required")
  const base = `/accounts/${account}/workers/workers/${worker}/previews`
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
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const remove = async (name: string) => {
    await api("delete", `${base}/${identifier(name)}`, { method: "DELETE" }, options.token, true)
  }
  const list = async () => {
    const all: CloudflarePreview[] = []
    const seen = new Set<string>()
    for (let page = 1; page <= 1000; page++) {
      const response = await api("list", `${base}?page=${page}&per_page=100`)
      if (!response || !Array.isArray(response.result))
        throw new Error("Cloudflare preview list returned invalid results")
      const results = response.result.map(preview)
      for (const item of results) {
        if (seen.has(item.id)) throw new Error("Cloudflare preview list repeated a page")
        seen.add(item.id)
        all.push(item)
      }
      const info = response.result_info ? object(response.result_info) : undefined
      if (typeof info?.total_pages === "number") {
        if (page >= info.total_pages) return all
      } else if (results.length < 100) return all
    }
    throw new Error("Cloudflare preview list exceeded pagination limit")
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
        [...file.path].some((character) => character.charCodeAt(0) < 32) ||
        !file.contentType ||
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
    let found = await api("get", `${base}/${name}`, {}, options.token, true)
    if (!found)
      found = await api("create", `${base}?ignore_base_config=true`, json({ name: input.name }))
    if (!found) throw new Error("Cloudflare preview creation failed")
    const resource = preview(found.result)
    const target = `${base}/${identifier(resource.id)}/deployments`
    const latest = await api("get latest deployment", `${target}/latest`, {}, options.token, true)
    if (latest) {
      const deployment = object(latest.result)
      const annotations = deployment.annotations ? object(deployment.annotations) : {}
      if (annotations["workers/tag"] === tag && annotations["workers/commit_sha"] === input.commit)
        return { action: "unchanged", preview: resource }
    }
    const session = await api(
      "asset session",
      `/accounts/${account}/workers/scripts/${worker}/assets-upload-session`,
      json({ manifest }),
    )
    const upload = object(session?.result)
    if (typeof upload.jwt !== "string" || !Array.isArray(upload.buckets))
      throw new Error("Invalid Cloudflare asset upload session")
    let completion = upload.buckets.length === 0 ? upload.jwt : undefined
    for (const bucket of upload.buckets) {
      if (
        !Array.isArray(bucket) ||
        bucket.some((hash) => typeof hash !== "string" || !blobs.has(hash))
      )
        throw new Error("Cloudflare requested an unknown preview asset")
      const form = new FormData()
      for (const hash of bucket as string[]) {
        const file = blobs.get(hash)
        if (!file) throw new Error("Missing preview asset")
        form.append(hash, new Blob([base64(file.bytes)], { type: file.contentType }), hash)
      }
      const result = await api(
        "asset upload",
        `/accounts/${account}/workers/assets/upload?base64=true`,
        { method: "POST", body: form },
        upload.jwt,
      )
      const body = object(result?.result)
      if (typeof body.jwt === "string") completion = body.jwt
    }
    if (!completion) throw new Error("Cloudflare asset upload did not complete")
    const final = await current()
    if (final !== "deploy") {
      if (final === "remove") await remove(input.name)
      return { action: final }
    }
    const form = new FormData()
    form.set(
      "metadata",
      JSON.stringify({
        compatibility_date: configuration.compatibility_date,
        assets: { jwt: completion, config: configuration.assets },
        env: {},
        annotations: { "workers/commit_sha": input.commit, "workers/tag": tag },
      }),
    )
    if (input.headers !== undefined)
      form.append("files", new File([input.headers], "_headers", { type: "text/plain" }))
    const deployed = await api("deploy", target, { method: "POST", body: form })
    const deployment = object(deployed?.result)
    if (typeof deployment.id !== "string") throw new Error("Invalid Cloudflare deployment response")
    return { action: "deployed", preview: resource, deploymentId: deployment.id }
  }
  return { deploy, list, remove }
}
