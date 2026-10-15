import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { signV4 } from "@crvouga/mockingbird-service"
import {
  type ArchiveRepository,
  boundedRepositoryText,
  type S3RepositoryOptions,
} from "./fleet-repository.js"

export type ConditionalValue<T> = { revision: string; value: T }
export type ConditionalStore<T> = {
  readonly kind: "filesystem" | "s3-etag"
  read(): Promise<ConditionalValue<T> | undefined>
  compareAndSwap(expected: string | undefined, value: T): Promise<boolean>
}
export function filesystemConditionalStore<T>(
  path: string,
  options: { durable?: boolean } = {},
): ConditionalStore<T> {
  const read = async (): Promise<ConditionalValue<T> | undefined> => {
    try {
      const text = await readFile(path, "utf8")
      if (text.length > 65536) throw new Error("conditional state exceeds limit")
      const record = JSON.parse(text) as ConditionalValue<T>
      if (typeof record.revision !== "string") throw new Error("invalid conditional state")
      return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }
  return {
    kind: "filesystem",
    read,
    async compareAndSwap(expected, value) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const lock = `${path}.lock`,
        token = randomUUID(),
        deadline = Date.now() + 2000
      for (;;) {
        try {
          await mkdir(lock)
          await writeFile(`${lock}/owner`, JSON.stringify({ pid: process.pid, token }), {
            mode: 0o600,
          })
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
          // Only a demonstrably dead same-host process can lose the mutex. A live but slow
          // process is never displaced by a timeout, so it cannot later complete a stale CAS.
          try {
            const owner = JSON.parse(await readFile(`${lock}/owner`, "utf8")) as { pid: number }
            try {
              process.kill(owner.pid, 0)
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code === "ESRCH") {
                await rm(lock, { recursive: true })
                continue
              }
            }
          } catch {}
          if (Date.now() >= deadline)
            throw new Error(
              "conditional store mutex unavailable; explicit recovery may be required",
            )
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      const temp = `${path}.${token}.tmp`
      try {
        const current = await read()
        if (current?.revision !== expected) return false
        const file = await open(temp, "wx", 0o600)
        try {
          await file.writeFile(JSON.stringify({ revision: randomUUID(), value }))
          if (options.durable) await file.sync()
        } finally {
          await file.close()
        }
        await rename(temp, path)
        if (options.durable) {
          const directory = await open(dirname(path), "r")
          try {
            await directory.sync()
          } finally {
            await directory.close()
          }
        }
        return true
      } finally {
        await rm(temp, { force: true })
        const owner = JSON.parse(await readFile(`${lock}/owner`, "utf8")) as { token: string }
        if (owner.token === token) await rm(lock, { recursive: true })
      }
    },
  }
}
export function s3ConditionalStore<T>(
  options: S3RepositoryOptions,
  key = `${options.prefix ?? "mockingbird-backups/"}writer.json`,
): ConditionalStore<T> {
  const request = async (method: string, value?: T, revision?: string) => {
    const url = new URL(options.endpoint)
    if (options.pathStyle !== false)
      url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(options.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`
    else {
      url.hostname = `${options.bucket}.${url.hostname}`
      url.pathname = `/${key.split("/").map(encodeURIComponent).join("/")}`
    }
    const body = new TextEncoder().encode(value === undefined ? "" : JSON.stringify(value))
    if (body.length > 65536) throw new Error("conditional state exceeds limit")
    const headers = await signV4({
      method,
      url,
      body,
      region: options.region,
      service: "s3",
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      headers: {
        ...(method === "PUT"
          ? revision === undefined
            ? { "if-none-match": "*" }
            : { "if-match": revision }
          : {}),
        ...(options.sessionToken ? { "x-amz-security-token": options.sessionToken } : {}),
      },
    })
    return (options.fetch ?? fetch)(url, {
      method,
      headers,
      ...(method === "PUT" ? { body } : {}),
      signal: AbortSignal.timeout(10000),
    })
  }
  return {
    kind: "s3-etag",
    async read() {
      const response = await request("GET")
      if (response.status === 404) {
        await response.body?.cancel()
        return undefined
      }
      if (!response.ok) throw new Error(`conditional store HTTP ${response.status}`)
      const revision = response.headers.get("etag")
      if (!revision) {
        await response.body?.cancel()
        throw new Error("storage provider lacks required ETag conditional semantics")
      }
      const text = await boundedRepositoryText(response, 65536)
      return { revision, value: JSON.parse(text) as T }
    },
    async compareAndSwap(expected, value) {
      const response = await request("PUT", value, expected)
      await response.body?.cancel()
      if ([409, 412].includes(response.status)) return false
      if (!response.ok) throw new Error(`conditional publication HTTP ${response.status}`)
      return true
    },
  }
}
export type WriterLease = { owner: string; generation: number; id: string; expiresAt: number }
export type WriterState = {
  lease: WriterLease
  latest?: { id: string; generation: number; verifiedAt: string }
}
export class RepositoryWriter {
  constructor(
    private readonly repository: ArchiveRepository,
    readonly control: ConditionalStore<WriterState>,
    private readonly now: () => number = Date.now,
  ) {}
  async acquire(owner: string, ttlMs: number, takeoverExpired = false): Promise<WriterLease> {
    if (!owner || !Number.isSafeInteger(ttlMs) || ttlMs < 1)
      throw new Error("owner and positive lease duration required")
    const current = await this.control.read()
    if (current && current.value.lease.expiresAt > this.now())
      throw new Error("repository writer already owned")
    if (current && !takeoverExpired)
      throw new Error("expired writer requires explicit takeover policy")
    const lease = {
      owner,
      generation: (current?.value.lease.generation ?? 0) + 1,
      id: randomUUID(),
      expiresAt: this.now() + ttlMs,
    }
    if (
      !(await this.control.compareAndSwap(current?.revision, {
        lease,
        ...(current?.value.latest ? { latest: current.value.latest } : {}),
      }))
    )
      throw new Error("writer ownership conflict")
    return lease
  }
  private valid(state: WriterState | undefined, lease: WriterLease) {
    if (
      !state ||
      state.lease.id !== lease.id ||
      state.lease.generation !== lease.generation ||
      state.lease.owner !== lease.owner ||
      state.lease.expiresAt <= this.now()
    )
      throw new Error("stale or expired repository writer")
  }
  async renew(lease: WriterLease, ttlMs: number) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1)
      throw new Error("positive lease duration required")
    const current = await this.control.read()
    this.valid(current?.value, lease)
    const renewed = { ...lease, expiresAt: this.now() + ttlMs }
    if (
      !(await this.control.compareAndSwap(current?.revision, { ...current?.value, lease: renewed }))
    )
      throw new Error("writer renewal conflict")
    return renewed
  }
  async publish(id: string, lease: WriterLease) {
    const verified = await this.repository.get(id)
    if (verified.sha256 !== id) throw new Error("recovery object verification failed")
    const current = await this.control.read()
    this.valid(current?.value, lease)
    if (
      !(await this.control.compareAndSwap(current?.revision, {
        lease: current?.value.lease as WriterLease,
        latest: {
          id,
          generation: lease.generation,
          verifiedAt: new Date(this.now()).toISOString(),
        },
      }))
    )
      throw new Error("conditional recovery publication conflict")
  }
  async latest() {
    const state = await this.control.read()
    const id = state?.value.latest?.id
    if (id) await this.repository.get(id)
    return id
  }
  bind(lease: WriterLease): ArchiveRepository {
    return {
      ...(this.repository.protectionPolicy
        ? { protectionPolicy: this.repository.protectionPolicy }
        : {}),
      writerGeneration: lease.generation,
      publicationMetadata: async () => (await this.control.read())?.value.latest,
      put: (a) => this.repository.put(a),
      get: (id) => this.repository.get(id),
      list: () => this.repository.list(),
      delete: async (id) => {
        if ((await this.latest()) === id)
          throw new Error("cannot delete current fenced recovery point")
        await this.repository.delete(id)
      },
      latest: () => this.latest(),
      publishLatest: (id) => this.publish(id, lease),
    }
  }
}
