import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { configFields, createContainer } from "./creation.js"

export const statuses = [
  "created",
  "running",
  "paused",
  "restarting",
  "removing",
  "exited",
  "dead",
] as const
export type Status = (typeof statuses)[number]
export type ImageRecord = {
  id: string
  tags: string[]
  platform?: string
  config?: Record<string, unknown>
}
export type ContainerRecord = {
  id: string
  name: string
  image: string
  imageId: string
  status: Status
  created: string
  startedAt: string
  finishedAt: string
  exitCode: number
  labels: Record<string, string>
  cmd: string[]
  entrypoint: string[]
  env: string[]
  workingDir: string
  user: string
  hostConfig: Record<string, unknown>
  networkSettings: Record<string, unknown>
  sizeRw: number
  sizeRootFs: number
  config?: Record<string, unknown>
  termination?: {
    operation: "stop" | "kill" | "remove"
    signal: number
    timeout?: number
    requestedAt: string
  }
  removalPending?: boolean
  stdinClosed?: boolean
}
export type DaemonSettings = { available: boolean; rootless: boolean }
export const zeroTime = "0001-01-01T00:00:00Z"
export const isRunning = (c: ContainerRecord) =>
  ["running", "paused", "restarting"].includes(c.status)
export class DockerInputError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
const invalid = (message: string): never => {
  throw new DockerInputError(400, message)
}
export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const strings = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
    return invalid(`${field}: expected string array`)
  return value
}
const text = (value: unknown, field: string, fallback = ""): string =>
  value === undefined
    ? fallback
    : typeof value === "string"
      ? value
      : invalid(`${field}: expected string`)
const size = (value: unknown, field: string): number =>
  value === undefined
    ? 0
    : Number.isSafeInteger(value) && Number(value) >= 0
      ? Number(value)
      : invalid(`${field}: expected nonnegative integer`)
const keys = (value: Record<string, unknown>, allowed: string[]) => {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) invalid(`unsupported seed field: ${key}`)
}

/** Synthetic records only. No host state, images or processes are accessed. */
export class DockerState {
  readonly images: Collection<ImageRecord>
  readonly containers: Collection<ContainerRecord>
  private readonly settings: Collection<DaemonSettings>
  private readonly ids: IdSequence
  constructor(
    private readonly sqlite: SqliteClient,
    namespace: string,
    private readonly now: () => number,
  ) {
    this.images = new Collection(sqlite, namespace, "docker-images")
    this.containers = new Collection(sqlite, namespace, "docker-containers")
    this.settings = new Collection(sqlite, namespace, "docker-daemon")
    this.ids = new IdSequence(sqlite, namespace, "docker-container")
  }
  create(value: unknown, url: URL) {
    return this.sqlite.transaction(() => createContainer(this, value, url, this.ids, this.now))
  }
  daemon(): DaemonSettings {
    return this.settings.get("settings") ?? { available: true, rootless: false }
  }
  updateDaemon(value: unknown): DaemonSettings {
    if (!record(value)) return invalid("daemon: expected object")
    keys(value, ["available", "rootless"])
    for (const v of Object.values(value))
      if (typeof v !== "boolean") invalid("daemon settings must be booleans")
    const next = { ...this.daemon(), ...value } as DaemonSettings
    this.settings.insert("settings", next)
    return next
  }
  seed(value: unknown) {
    if (!record(value)) return invalid("seed: expected object")
    keys(value, ["images", "containers", "daemon"])
    return this.sqlite.transaction(() => {
      if (value.images !== undefined) {
        if (!Array.isArray(value.images)) return invalid("images: expected array")
        for (const image of value.images) {
          if (!record(image)) return invalid("image: expected object")
          keys(image, ["id", "tags", "platform", "config"])
          const id = text(image.id, "image.id")
          if (!/^sha256:[a-f0-9]{64}$/.test(id)) invalid("image.id: expected sha256 digest")
          const tags = strings(image.tags ?? [], "image.tags")
          if (
            tags.some(
              (tag) =>
                !tag ||
                this.images.list().some((i) => i.value.id !== id && i.value.tags.includes(tag)),
            )
          )
            throw new DockerInputError(409, "image tag already exists or is empty")
          if (this.images.has(id)) throw new DockerInputError(409, "image id already exists")
          const platform = text(image.platform, "image.platform", "linux/amd64")
          if (!/^[a-z0-9]+\/[a-z0-9_]+(?:\/[a-z0-9_]+)?$/.test(platform))
            invalid("invalid image.platform")
          const config = configFields(image.config ?? {})
          this.images.insert(id, { id, tags, platform, config })
        }
      }
      if (value.containers !== undefined) {
        if (!Array.isArray(value.containers)) return invalid("containers: expected array")
        for (const input of value.containers) {
          if (!record(input)) return invalid("container: expected object")
          keys(input, [
            "id",
            "name",
            "image",
            "status",
            "exitCode",
            "labels",
            "cmd",
            "entrypoint",
            "env",
            "workingDir",
            "user",
            "hostConfig",
            "networkSettings",
            "sizeRw",
            "sizeRootFs",
          ])
          const id = text(input.id, "id")
          const name = text(input.name, "name").replace(/^\//, "")
          if (!/^[a-f0-9]{64}$/.test(id) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name))
            invalid("expected hex container id and valid name")
          if (this.containers.has(id) || this.containers.list().some((c) => c.value.name === name))
            throw new DockerInputError(409, "container id or name already exists")
          const image = text(input.image, "image")
          const resolved =
            this.images.get(image) ??
            this.images.list().find((i) => i.value.tags.includes(image))?.value
          if (!resolved) throw new DockerInputError(404, `No such image: ${image}`)
          const status = text(input.status, "status", "created") as Status
          if (!statuses.includes(status)) invalid("invalid container status")
          const labels = input.labels ?? {}
          if (!record(labels) || Object.values(labels).some((v) => typeof v !== "string"))
            invalid("labels: expected string map")
          const exitCode = input.exitCode ?? 0
          if (!Number.isSafeInteger(exitCode)) invalid("exitCode: expected integer")
          const hostConfig = input.hostConfig ?? {}
          const networkSettings = input.networkSettings ?? { Networks: {} }
          if (!record(hostConfig) || !record(networkSettings))
            invalid("hostConfig and networkSettings must be objects")
          const created = new Date(this.now()).toISOString()
          this.containers.insert(id, {
            id,
            name,
            image,
            imageId: resolved.id,
            status,
            created,
            startedAt: status === "created" ? zeroTime : created,
            finishedAt: ["exited", "dead", "restarting"].includes(status) ? created : zeroTime,
            exitCode: exitCode as number,
            labels: labels as Record<string, string>,
            cmd: strings(input.cmd ?? [], "cmd"),
            entrypoint: strings(input.entrypoint ?? [], "entrypoint"),
            env: strings(input.env ?? [], "env"),
            workingDir: text(input.workingDir, "workingDir"),
            user: text(input.user, "user"),
            hostConfig: hostConfig as Record<string, unknown>,
            networkSettings: networkSettings as Record<string, unknown>,
            sizeRw: size(input.sizeRw, "sizeRw"),
            sizeRootFs: size(input.sizeRootFs, "sizeRootFs"),
          })
        }
      }
      if (value.daemon !== undefined) this.updateDaemon(value.daemon)
      return { images: this.images.list().length, containers: this.containers.list().length }
    })
  }
  find(id: string): ContainerRecord {
    const direct =
      this.containers.get(id) ??
      this.containers.list().find((c) => c.value.name === id.replace(/^\//, ""))?.value
    if (direct) return direct
    const matches = this.containers.list().filter((c) => c.id.startsWith(id))
    if (matches.length === 1 && matches[0]) return matches[0].value
    if (matches.length > 1)
      throw new DockerInputError(400, `multiple IDs found with provided prefix: ${id}`)
    throw new DockerInputError(404, `No such container: ${id}`)
  }
}
