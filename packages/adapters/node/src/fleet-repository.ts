import type { ArchiveProtector } from "./fleet-protection.js"
import { randomUUID } from "node:crypto"
import { link, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { signV4 } from "@crvouga/mockingbird-service"
import { type FleetArchive, validateArchive } from "./fleet-archive.js"

/** A repository must be independent of the application services being captured. */
export type ArchiveRepository = {
  readonly protectionPolicy?: ArchiveProtector["policy"]
  readonly writerGeneration?: number
  publicationMetadata?(): Promise<{ id: string; generation: number; verifiedAt: string } | undefined>
  put(archive: FleetArchive): Promise<string>
  get(id: string): Promise<FleetArchive>
  list(): Promise<string[]>
  delete(id: string): Promise<void>
  latest(): Promise<string | undefined>
  publishLatest(id: string): Promise<void>
}
const validId = (id: string) => {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid archive id")
  return id
}
const bytes = async (archive: FleetArchive, max: number, protection?: ArchiveProtector) => {
  validateArchive(archive)
  const encoded = new TextEncoder().encode(JSON.stringify(protection ? await protection.seal(archive) : archive))
  if (encoded.length > max) throw new Error("archive exceeds repository byte limit")
  return encoded
}
export const boundedRepositoryText = async (response: Response, max: number) => {
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`archive repository HTTP ${response.status}`)
  }
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader)
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.length
        if (size > max) throw new Error("archive exceeds repository byte limit")
        chunks.push(next.value)
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
  return Buffer.concat(chunks).toString("utf8")
}

export function filesystemRepository(
  directory: string,
  maxBytes = 64 * 1024 * 1024,
  protection?: ArchiveProtector,
): ArchiveRepository {
  const path = (id: string) => join(directory, `${validId(id)}.json`)
  const atomic = async (name: string, data: string | Uint8Array) => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temp = join(directory, `${randomUUID()}.tmp`)
    try {
      await writeFile(temp, data, { mode: 0o600, flag: "wx" })
      await rename(temp, join(directory, name))
    } finally {
      await rm(temp, { force: true })
    }
  }
  const repo: ArchiveRepository = {
    ...(protection ? { protectionPolicy: protection.policy } : {}),
    async put(archive) {
      const data = await bytes(archive, maxBytes, protection),
        id = archive.sha256
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temp = join(directory, `${randomUUID()}.tmp`)
      try {
        const file = await open(temp, "wx", 0o600)
        try {
          await file.writeFile(data)
          await file.sync()
        } finally {
          await file.close()
        }
        try {
          await link(temp, path(id))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        }
      } finally {
        await rm(temp, { force: true })
      }
      if ((await repo.get(id)).sha256 !== id) throw new Error("archive verification failed")
      return id
    },
    async get(id) {
      const file = await open(path(id), "r")
      try {
        if ((await file.stat()).size > maxBytes)
          throw new Error("archive exceeds repository byte limit")
        const input: unknown = JSON.parse(await file.readFile("utf8"))
        const doc = protection ? await protection.open(input) : validateArchive(input)
        if (doc.sha256 !== id) throw new Error("archive identity mismatch")
        return doc
      } finally {
        await file.close()
      }
    },
    async list() {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const names = (await readdir(directory)).filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
      const entries = await Promise.all(
        names.map(async (n) => ({
          id: n.slice(0, -5),
          time: Date.parse((await repo.get(n.slice(0, -5))).createdAt),
        })),
      )
      return entries.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id)).map((e) => e.id)
    },
    async delete(id) {
      if ((await repo.latest()) === id) throw new Error("cannot delete latest verified archive")
      await rm(path(id))
    },
    async latest() {
      try {
        const id = (await readFile(join(directory, "latest"), "utf8")).trim()
        validId(id)
        await repo.get(id)
        return id
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      }
    },
    async publishLatest(id) {
      await repo.get(id)
      await atomic("latest", `${validId(id)}\n`)
    },
  }
  return repo
}

export type S3RepositoryOptions = {
  protection?: ArchiveProtector
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  prefix?: string
  pathStyle?: boolean
  maxBytes?: number
  fetch?: typeof fetch
}
/** Signed S3 general-purpose bucket API, with explicit endpoint/credentials and bounded transfers. */
export function s3Repository(options: S3RepositoryOptions): ArchiveRepository {
  const protection = options.protection
  const max = options.maxBytes ?? 64 * 1024 * 1024
  const prefix = options.prefix ?? "mockingbird-backups/"
  const send = async (
    method: string,
    key: string,
    data?: Uint8Array,
    headers: Record<string, string> = {},
    query?: URLSearchParams,
  ) => {
    const url = new URL(options.endpoint)
    if (url.username || url.password)
      throw new Error("repository endpoint must not contain credentials")
    if (options.pathStyle !== false)
      url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(options.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`
    else {
      url.hostname = `${options.bucket}.${url.hostname}`
      url.pathname = `/${key.split("/").map(encodeURIComponent).join("/")}`
    }
    if (query) url.search = query.toString()
    const signed = await signV4({
      method,
      url,
      body: data ?? new Uint8Array(),
      region: options.region,
      service: "s3",
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      headers: {
        ...headers,
        ...(options.sessionToken ? { "x-amz-security-token": options.sessionToken } : {}),
      },
    })
    return (options.fetch ?? fetch)(url, {
      method,
      headers: signed,
      ...(data !== undefined ? { body: data as BodyInit } : {}),
      signal: AbortSignal.timeout(30000),
    })
  }
  const repo: ArchiveRepository = {
    ...(protection ? { protectionPolicy: protection.policy } : {}),
    async put(archive) {
      const data = await bytes(archive, max, protection),
        id = archive.sha256
      const response = await send("PUT", `${prefix}${id}.json`, data, {
        "if-none-match": "*",
        "content-type": "application/json",
      })
      if (!response.ok && response.status !== 412)
        throw new Error(`archive upload HTTP ${response.status}`)
      await response.body?.cancel()
      if ((await repo.get(id)).sha256 !== id) throw new Error("archive verification failed")
      return id
    },
    async get(id) {
      const input: unknown = JSON.parse(await boundedRepositoryText(await send("GET", `${prefix}${validId(id)}.json`), max))
      const archive = protection ? await protection.open(input) : validateArchive(input)
      if (archive.sha256 !== id) throw new Error("archive identity mismatch")
      return archive
    },
    async list() {
      const ids: string[] = []
      let token: string | undefined
      do {
        const query = new URLSearchParams({ "list-type": "2", prefix })
        if (token) query.set("continuation-token", token)
        const xml = await boundedRepositoryText(await send("GET", "", undefined, {}, query), 4 * 1024 * 1024)
        for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
          const key = match[1] ?? ""
          const id = key.slice(prefix.length, -5)
          if (key.startsWith(prefix) && key.endsWith(".json") && /^[a-f0-9]{64}$/.test(id))
            ids.push(id)
        }
        token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/
          .exec(xml)?.[1]
          ?.replaceAll("&amp;", "&")
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&quot;", '"')
          .replaceAll("&apos;", "'")
        if (ids.length > 10000) throw new Error("repository listing exceeds limit")
      } while (token)
      const rows = await Promise.all(
        ids.map(async (id) => ({ id, time: Date.parse((await repo.get(id)).createdAt) })),
      )
      return rows.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id)).map((r) => r.id)
    },
    async delete(id) {
      if ((await repo.latest()) === id) throw new Error("cannot delete latest verified archive")
      const response = await send("DELETE", `${prefix}${validId(id)}.json`)
      if (!response.ok) throw new Error(`archive delete HTTP ${response.status}`)
      await response.body?.cancel()
    },
    async latest() {
      const response = await send("GET", `${prefix}latest`)
      if (response.status === 404) {
        await response.body?.cancel()
        return undefined
      }
      const id = (await boundedRepositoryText(response, 256)).trim()
      validId(id)
      await repo.get(id)
      return id
    },
    async publishLatest(id) {
      await repo.get(id)
      const response = await send(
        "PUT",
        `${prefix}latest`,
        new TextEncoder().encode(`${validId(id)}\n`),
      )
      if (!response.ok) throw new Error(`latest publication HTTP ${response.status}`)
      await response.body?.cancel()
    },
  }
  return repo
}
