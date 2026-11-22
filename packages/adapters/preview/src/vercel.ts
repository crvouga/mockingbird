/**
 * Previews hosted on Vercel instead of Cloudflare Workers, behind the same `PreviewHosting`
 * interface the reusable workflow drives (`hosting: vercel`).
 *
 * Each preview `<name>` is a static Vercel deployment aliased to `<name>.<domain>` (or
 * `<name>.vercel.app`). Vercel runs no code here, so the live status a Worker serves from its env
 * is a static file instead: every deploy and every `setStatus` writes `/__preview/status` (the
 * same snapshot JSON the Worker's `/__preview/status` answers) and creates a new deployment from
 * the files Vercel already holds, which only uploads the changed status file, then moves the alias
 * and deletes the deployment it pointed at. The boot loader finds no `/__preview/live` stream and
 * polls `/__preview/status`, as it does whenever Server-Sent Events are unavailable.
 *
 * The REST calls follow Vercel's public API documentation (files `POST /v2/files` with a SHA-1
 * digest, `POST /v13/deployments`, aliases `POST /v2/deployments/{id}/aliases`,
 * `GET /v4/aliases/{alias}`, `DELETE /v2/aliases/{id}`, `DELETE /v13/deployments/{id}`). They are
 * a **best guess, not verified** against a live Vercel account.
 *
 * Portable: Fetch and Web Crypto only.
 */
import type { PreviewDownload } from "./artifacts.js"
import type { PreviewAssetFile } from "./cloudflare.js"
import { createPreviewStatus, PREVIEW_ENV } from "./preview-status.js"

/**
 * Where previews are hosted: the reusable workflow's `hosting` input picks one. The Cloudflare
 * Worker host is driven by the workflow with wrangler; `createVercelPreviewHosting` implements this
 * for Vercel.
 */
export type PreviewHosting = {
  /** Whether preview `name` is deployed (status writes skip a preview that is not). */
  exists(name: string): Promise<boolean>
  /** Deploys `files` as preview `name` with `vars` (`PREVIEW_PR`, …); resolves with its URL. */
  deploy(input: {
    name: string
    files: PreviewAssetFile[]
    vars?: Record<string, string>
  }): Promise<{ url: string }>
  /** Merges `values` (`PREVIEW_BUILD` / `PREVIEW_CHECKS`) into the preview's status. */
  setStatus(name: string, values: Record<string, string>): Promise<void>
  /** Removes preview `name`; a preview that is already gone is fine. */
  remove(name: string): Promise<void>
}

/** The public file a Vercel preview keeps its vars and file list in, for `setStatus`. */
export const VERCEL_PREVIEW_STATE = "/__preview/deployment.json"
/** The static status snapshot. */
export const VERCEL_PREVIEW_STATUS = "/__preview/status"

/** What a Vercel preview's `/__preview/deployment.json` holds. */
export type VercelPreviewState = {
  vars: Record<string, string>
  files: { file: string; sha: string; size: number }[]
}

type Json = Record<string, unknown>

const sha1 = async (bytes: Uint8Array) => {
  const hash = await crypto.subtle.digest("SHA-1", new Uint8Array(bytes))
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/

/** `vercel.json` for a static preview: no build, SPA fallback, never-cached status files. */
export const vercelPreviewConfig = () => ({
  buildCommand: "",
  installCommand: "",
  framework: null,
  outputDirectory: ".",
  // Rewrites apply only when no file matches; /__preview/* (live, …) stays a 404 so the boot loader
  // falls back to polling the static status.
  rewrites: [{ source: "/((?!__preview/).*)", destination: "/index.html" }],
  headers: [
    {
      source: "/version.json",
      headers: [{ key: "cache-control", value: "no-store" }],
    },
    {
      source: "/__preview/(.*)",
      headers: [
        { key: "cache-control", value: "no-store" },
        { key: "content-type", value: "application/json; charset=utf-8" },
      ],
    },
  ],
})

/**
 * Hosts previews on Vercel. `token` is a Vercel access token, `project` the project id or name,
 * `teamId` the team (`VERCEL_ORG_ID`) when the project belongs to one. Preview `name` is served at
 * `https://<name>.<domain>` (a domain on the project, e.g. `preview.example.com` with a wildcard
 * record) or, without `domain`, `https://<name>.vercel.app`.
 */
export function createVercelPreviewHosting(options: {
  token: string
  project: string
  teamId?: string
  domain?: string
  /** Vercel's "Protection Bypass for Automation" secret, when Deployment Protection is on. */
  bypassSecret?: string
  fetch?: PreviewDownload
  apiUrl?: string
  sleep?: (ms: number) => Promise<void>
  /** How long a deployment may take to become ready. Default 300 000 ms. */
  readyTimeoutMs?: number
}): PreviewHosting {
  if (!options.token) throw new Error("A Vercel token is required (VERCEL_TOKEN)")
  if (!options.project) throw new Error("A Vercel project is required (VERCEL_PROJECT_ID)")
  if (options.domain !== undefined && !DOMAIN.test(options.domain))
    throw new Error(`Invalid Vercel preview domain ${options.domain}`)
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const api = (options.apiUrl ?? "https://api.vercel.com").replace(/\/$/, "")
  const team = options.teamId ? `teamId=${encodeURIComponent(options.teamId)}` : ""
  const withTeam = (path: string) =>
    team ? `${path}${path.includes("?") ? "&" : "?"}${team}` : path

  const call = async (
    operation: string,
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
    allow: number[] = [],
  ): Promise<{ status: number; body: Json }> => {
    let response: Response
    try {
      const raw = init.body instanceof Uint8Array
      response = await doFetch(`${api}${withTeam(path)}`, {
        method: init.method ?? "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${options.token}`,
          ...(init.body === undefined || raw ? {} : { "content-type": "application/json" }),
          ...(init.headers ?? {}),
        },
        ...(init.body === undefined
          ? {}
          : {
              body: raw
                ? new Blob([init.body as Uint8Array<ArrayBuffer>])
                : JSON.stringify(init.body),
            }),
      })
    } catch {
      throw new Error(`Vercel ${operation} failed (network)`)
    }
    let body: Json = {}
    try {
      const text = await response.text()
      body = text ? (JSON.parse(text) as Json) : {}
    } catch {}
    if (!response.ok && !allow.includes(response.status))
      throw new Error(`Vercel ${operation} failed (HTTP ${response.status})`)
    return { status: response.status, body }
  }

  const alias = (name: string) => {
    if (!LABEL.test(name)) throw new Error(`Invalid preview name ${name}`)
    return `${name}.${options.domain ?? "vercel.app"}`
  }

  const findAlias = async (name: string) => {
    const found = await call(
      "get alias",
      `/v4/aliases/${encodeURIComponent(alias(name))}`,
      {},
      [404],
    )
    if (found.status === 404) return undefined
    const uid = found.body.uid
    const deploymentId = found.body.deploymentId
    return {
      uid: typeof uid === "string" ? uid : undefined,
      deploymentId: typeof deploymentId === "string" ? deploymentId : undefined,
    }
  }

  const upload = async (bytes: Uint8Array, sha: string) => {
    await call("file upload", "/v2/files", {
      method: "POST",
      body: bytes,
      headers: {
        "content-type": "application/octet-stream",
        "x-vercel-digest": sha,
        "x-vercel-size": String(bytes.byteLength),
      },
    })
  }

  /** Creates a deployment from `files`, uploading only what Vercel reports missing. */
  const createDeployment = async (
    files: VercelPreviewState["files"],
    bytes: Map<string, Uint8Array>,
    meta: Record<string, string>,
  ) => {
    const body = {
      name: options.project,
      project: options.project,
      files,
      meta,
      projectSettings: {
        framework: null,
        buildCommand: "",
        installCommand: "",
        outputDirectory: ".",
      },
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const created = await call(
        "create deployment",
        "/v13/deployments?skipAutoDetectionConfirmation=1",
        { method: "POST", body },
        [400],
      )
      if (created.status !== 400) {
        if (typeof created.body.id !== "string") throw new Error("Invalid Vercel deployment")
        return created.body.id
      }
      const error = (created.body.error ?? {}) as Json
      const missing = Array.isArray(error.missing) ? (error.missing as unknown[]) : undefined
      if (error.code !== "missing_files" || !missing || attempt > 0)
        throw new Error(
          `Vercel create deployment failed (HTTP 400${typeof error.code === "string" ? ` ${error.code}` : ""})`,
        )
      for (const sha of missing) {
        const content = typeof sha === "string" ? bytes.get(sha) : undefined
        if (!content) throw new Error("Vercel asked for a file this deploy does not have")
        await upload(content, sha as string)
      }
    }
    throw new Error("Vercel create deployment failed")
  }

  const waitReady = async (id: string) => {
    const deadline = Date.now() + (options.readyTimeoutMs ?? 300_000)
    for (;;) {
      const { body } = await call("get deployment", `/v13/deployments/${encodeURIComponent(id)}`)
      const state = body.readyState ?? body.status
      if (state === "READY") return
      if (state === "ERROR" || state === "CANCELED")
        throw new Error(`Vercel deployment ${id} ended ${String(state)}`)
      if (Date.now() > deadline) throw new Error(`Vercel deployment ${id} never became ready`)
      await sleep(3_000)
    }
  }

  /** Points the alias at `id` and deletes the deployment it pointed at before. */
  const publish = async (name: string, id: string) => {
    const previous = await findAlias(name)
    await call("set alias", `/v2/deployments/${encodeURIComponent(id)}/aliases`, {
      method: "POST",
      body: { alias: alias(name) },
    })
    if (previous?.deploymentId && previous.deploymentId !== id)
      await call(
        "delete deployment",
        `/v13/deployments/${encodeURIComponent(previous.deploymentId)}`,
        { method: "DELETE" },
        [404],
      )
  }

  const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)

  /** The deployment's generated files: vercel.json, the status snapshot and its state. */
  const generated = async (
    vars: Record<string, string>,
    version: unknown,
    files: VercelPreviewState["files"],
  ) => {
    const response = await createPreviewStatus({
      env: () => vars,
      readVersion: async () => version as { version: string; builtAt: string } | undefined,
    })(new Request(`https://${options.domain ?? "preview.local"}${VERCEL_PREVIEW_STATUS}`))
    const status = new Uint8Array(await (response as Response).arrayBuffer())
    const config = encode(vercelPreviewConfig())
    const out = new Map<string, Uint8Array>([
      ["vercel.json", config],
      [VERCEL_PREVIEW_STATUS.slice(1), status],
    ])
    const listed: VercelPreviewState["files"] = []
    for (const [file, bytes] of out)
      listed.push({ file, sha: await sha1(bytes), size: bytes.length })
    const state: VercelPreviewState = { vars, files: [...files, ...listed] }
    const stateBytes = encode(state)
    out.set(VERCEL_PREVIEW_STATE.slice(1), stateBytes)
    listed.push({
      file: VERCEL_PREVIEW_STATE.slice(1),
      sha: await sha1(stateBytes),
      size: stateBytes.length,
    })
    return { out, listed }
  }

  const GENERATED = new Set([
    "vercel.json",
    VERCEL_PREVIEW_STATUS.slice(1),
    VERCEL_PREVIEW_STATE.slice(1),
  ])

  const deployFiles = async (
    name: string,
    files: VercelPreviewState["files"],
    bytes: Map<string, Uint8Array>,
    vars: Record<string, string>,
    version: unknown,
  ) => {
    const { out, listed } = await generated(vars, version, files)
    for (const item of listed) {
      const content = out.get(item.file)
      if (content) bytes.set(item.sha, content)
    }
    const id = await createDeployment([...files, ...listed], bytes, { previewName: name })
    await waitReady(id)
    await publish(name, id)
    return { url: `https://${alias(name)}` }
  }

  const exists = async (name: string) => (await findAlias(name)) !== undefined

  const deploy: PreviewHosting["deploy"] = async (input) => {
    const files: VercelPreviewState["files"] = []
    const bytes = new Map<string, Uint8Array>()
    let version: unknown
    for (const item of input.files) {
      const file = item.path.replace(/^\/+/, "")
      if (!file || file.split("/").some((part) => part === "" || part === "." || part === ".."))
        throw new Error(`Invalid preview file path ${item.path}`)
      if (GENERATED.has(file))
        throw new Error(`${item.path} is written by the Vercel preview host; remove it from outdir`)
      const sha = await sha1(item.bytes)
      files.push({ file, sha, size: item.bytes.byteLength })
      bytes.set(sha, item.bytes)
      if (file === "version.json")
        try {
          version = JSON.parse(new TextDecoder().decode(item.bytes))
        } catch {}
    }
    return deployFiles(input.name, files, bytes, input.vars ?? {}, version)
  }

  const setStatus: PreviewHosting["setStatus"] = async (name, values) => {
    for (const key of Object.keys(values))
      if (key !== PREVIEW_ENV.build && key !== PREVIEW_ENV.checks && key !== PREVIEW_ENV.pr)
        throw new Error(`Vercel previews hold only PREVIEW_* status values, not ${key}`)
    const origin = `https://${alias(name)}`
    const read = async (path: string) => {
      const response = await doFetch(`${origin}${path}?t=${Date.now()}`, {
        cache: "no-store",
        redirect: "error",
        headers: options.bypassSecret ? { "x-vercel-protection-bypass": options.bypassSecret } : {},
      })
      if (!response.ok) throw new Error(`${origin}${path}: HTTP ${response.status}`)
      return (await response.json()) as unknown
    }
    const state = (await read(VERCEL_PREVIEW_STATE)) as Partial<VercelPreviewState>
    if (!state || !Array.isArray(state.files) || typeof state.vars !== "object" || !state.vars)
      throw new Error(`${origin}${VERCEL_PREVIEW_STATE} is not a preview state`)
    const files = state.files.filter((file) => !GENERATED.has(file.file))
    const version = files.some((file) => file.file === "version.json")
      ? await read("/version.json").catch(() => undefined)
      : undefined
    await deployFiles(name, files, new Map(), { ...state.vars, ...values }, version)
  }

  const remove = async (name: string) => {
    const found = await findAlias(name)
    if (!found) return
    if (found.uid)
      await call(
        "delete alias",
        `/v2/aliases/${encodeURIComponent(found.uid)}`,
        { method: "DELETE" },
        [404],
      )
    if (found.deploymentId)
      await call(
        "delete deployment",
        `/v13/deployments/${encodeURIComponent(found.deploymentId)}`,
        { method: "DELETE" },
        [404],
      )
  }

  return { exists, deploy, setStatus, remove }
}
