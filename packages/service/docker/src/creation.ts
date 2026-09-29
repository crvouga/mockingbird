import type { IdSequence } from "@crvouga/mockingbird-service"
import { DockerInputError, type DockerState, record, zeroTime } from "./state.js"

const fail = (field: string): never => {
  throw new DockerInputError(400, `invalid ${field}`)
}
const unsupported = (field: string): never => {
  throw new DockerInputError(501, `Mockingbird: unsupported create field ${field}`)
}
const arrayFields = ["Cmd", "Entrypoint", "Env"]
const stringFields = ["Image", "WorkingDir", "User", "StopSignal", "Hostname", "Domainname"]
const booleanFields = [
  "AttachStdin",
  "AttachStdout",
  "AttachStderr",
  "OpenStdin",
  "StdinOnce",
  "Tty",
  "NetworkDisabled",
]

/** Validate the selected wire fields; this stores configuration, never executes it. */
export const configFields = (input: unknown): Record<string, unknown> => {
  if (!record(input)) return fail("container config")
  for (const [key, value] of Object.entries(input)) {
    if (![...arrayFields, ...stringFields, ...booleanFields, "Labels", "StopTimeout"].includes(key))
      unsupported(key)
    if (value === null) continue
    if (
      arrayFields.includes(key) &&
      (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
    )
      fail(key)
    if (stringFields.includes(key) && typeof value !== "string") fail(key)
    if (booleanFields.includes(key) && typeof value !== "boolean") fail(key)
    if (
      key === "Labels" &&
      (!record(value) || Object.values(value).some((v) => typeof v !== "string"))
    )
      fail(key)
    if (key === "StopTimeout" && (!Number.isSafeInteger(value) || Number(value) < -1)) fail(key)
    if (key === "WorkingDir" && typeof value === "string" && value && !value.startsWith("/"))
      fail(key)
    if (key === "StopSignal" && typeof value === "string" && value) {
      const signal = value.toUpperCase().replace(/^SIG/, "")
      if (
        !/^(HUP|INT|QUIT|ILL|TRAP|ABRT|IOT|BUS|FPE|KILL|USR1|SEGV|USR2|PIPE|ALRM|TERM|STKFLT|CHLD|CLD|CONT|STOP|TSTP|TTIN|TTOU|URG|XCPU|XFSZ|VTALRM|PROF|WINCH|IO|POLL|PWR|SYS|UNUSED)$/.test(
          signal,
        ) &&
        !(/^\d+$/.test(signal) && Number(signal) <= 64)
      )
        fail(key)
    }
  }
  return structuredClone(input)
}
const hostFields = (value: unknown) => {
  if (value == null) return {}
  if (!record(value)) return fail("HostConfig")
  const types: Record<string, string> = {
    NetworkMode: "string",
    IpcMode: "string",
    PidMode: "string",
    CgroupnsMode: "string",
    Runtime: "string",
    AutoRemove: "boolean",
    ReadonlyRootfs: "boolean",
    Privileged: "boolean",
    Init: "boolean",
    Memory: "integer",
    MemorySwap: "integer",
    NanoCpus: "integer",
    CpuShares: "integer",
    PidsLimit: "integer",
    Binds: "strings",
    CapDrop: "strings",
    CapAdd: "strings",
    SecurityOpt: "strings",
    Dns: "strings",
    ExtraHosts: "strings",
    Mounts: "objects",
    Tmpfs: "stringmap",
    PortBindings: "object",
    RestartPolicy: "object",
    LogConfig: "object",
  }
  for (const [key, v] of Object.entries(value)) {
    const type = types[key]
    if (!type) unsupported(`HostConfig.${key}`)
    if (v === null) continue
    if (["string", "boolean"].includes(type ?? "") && typeof v !== type) fail(`HostConfig.${key}`)
    if (type === "integer" && !Number.isSafeInteger(v)) fail(`HostConfig.${key}`)
    if (type === "strings" && (!Array.isArray(v) || !v.every((x) => typeof x === "string")))
      fail(`HostConfig.${key}`)
    if (type === "objects" && (!Array.isArray(v) || !v.every(record))) fail(`HostConfig.${key}`)
    if ((type === "object" || type === "stringmap") && !record(v)) fail(`HostConfig.${key}`)
    if (type === "stringmap" && record(v) && Object.values(v).some((x) => typeof x !== "string"))
      fail(`HostConfig.${key}`)
  }
  return structuredClone(value)
}
const endpoints = (value: unknown): Record<string, unknown> => {
  if (value == null) return {}
  if (!record(value) || Object.keys(value).some((k) => k !== "EndpointsConfig"))
    return fail("NetworkingConfig")
  if (value.EndpointsConfig == null) return {}
  if (!record(value.EndpointsConfig)) return fail("NetworkingConfig.EndpointsConfig")
  for (const endpoint of Object.values(value.EndpointsConfig)) {
    if (!record(endpoint)) return fail("network endpoint")
    if (
      endpoint.Aliases != null &&
      (!Array.isArray(endpoint.Aliases) || !endpoint.Aliases.every((v) => typeof v === "string"))
    )
      fail("network aliases")
  }
  return structuredClone(value.EndpointsConfig)
}
export const createContainer = (
  state: DockerState,
  value: unknown,
  url: URL,
  ids: IdSequence,
  now: () => number,
) => {
  if (!record(value)) return fail("JSON body")
  const { HostConfig, NetworkingConfig, ...rest } = value
  const requested = configFields(rest)
  const hostConfig = hostFields(HostConfig)
  const networks = endpoints(NetworkingConfig)
  const image = typeof requested.Image === "string" ? requested.Image : ""
  const reference = image.includes(":") || image.includes("@") ? image : `${image}:latest`
  const resolved =
    state.images.get(image) ??
    state.images
      .list()
      .find((i) => i.value.tags.includes(image) || i.value.tags.includes(reference))?.value
  if (!resolved) throw new DockerInputError(404, `No such image: ${reference}`)
  const platform = url.searchParams.get("platform") || ""
  if (platform && !/^[a-z0-9]+(?:\/[a-z0-9_]+){0,2}$/.test(platform)) fail("platform")
  const imagePlatform = resolved.platform ?? "linux/amd64"
  if (platform && imagePlatform !== platform && !imagePlatform.startsWith(`${platform}/`))
    throw new DockerInputError(404, `No such image: ${reference} (platform ${platform})`)
  const warnings =
    !platform && imagePlatform !== "linux/amd64"
      ? [
          `The requested image's platform (${imagePlatform}) does not match the detected host platform (linux/amd64) and no specific platform was requested`,
        ]
      : []
  const defaults = resolved.config ?? {}
  const arr = (obj: Record<string, unknown>, key: string) => (obj[key] ?? []) as string[]
  let cmd = arr(requested, "Cmd")
  let entrypoint = arr(requested, "Entrypoint")
  if (entrypoint.length === 0) {
    if (cmd.length === 0) cmd = arr(defaults, "Cmd")
    if (requested.Entrypoint == null) entrypoint = arr(defaults, "Entrypoint")
  }
  if (entrypoint.length === 1 && entrypoint[0] === "") entrypoint = []
  if (cmd.length + entrypoint.length === 0) throw new DockerInputError(400, "no command specified")
  const env = [...arr(requested, "Env")]
  for (const item of arr(defaults, "Env"))
    if (!env.some((v) => v.split("=", 1)[0] === item.split("=", 1)[0])) env.push(item)
  const labels = {
    ...((defaults.Labels as Record<string, string>) ?? {}),
    ...((requested.Labels as Record<string, string>) ?? {}),
  }
  const config: Record<string, unknown> = {
    Image: image,
    Cmd: cmd,
    Entrypoint: entrypoint,
    Env: env,
    Labels: labels,
  }
  for (const key of stringFields.filter((k) => k !== "Image"))
    config[key] = requested[key] || defaults[key] || ""
  for (const key of booleanFields) config[key] = requested[key] ?? false
  if (requested.StopTimeout != null || defaults.StopTimeout != null)
    config.StopTimeout = requested.StopTimeout ?? defaults.StopTimeout
  let name = (url.searchParams.get("name") ?? "").replace(/^\//, "")
  if (url.searchParams.get("name") && !name) fail("container name")
  if (name && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name)) fail("container name")
  const conflict = state.containers.list().find((c) => c.value.name === name)
  if (name && conflict)
    throw new DockerInputError(
      409,
      `Conflict. The container name "/${name}" is already in use by container "${conflict.id}". You have to remove (or rename) that container to be able to reuse that name.`,
    )
  let id: string
  do {
    id = [...ids.next("", 32)].map((c) => c.charCodeAt(0).toString(16)).join("")
  } while (
    state.containers.has(id) ||
    (!name &&
      state.containers.list().some((c) => c.value.name === `mockingbird_${id.slice(0, 12)}`))
  )
  name ||= `mockingbird_${id.slice(0, 12)}`
  config.Hostname ||= id.slice(0, 12)
  state.containers.insert(id, {
    id,
    name,
    image,
    imageId: resolved.id,
    status: "created",
    created: new Date(now()).toISOString(),
    startedAt: zeroTime,
    finishedAt: zeroTime,
    exitCode: 0,
    labels,
    cmd,
    entrypoint,
    env,
    workingDir: String(config.WorkingDir),
    user: String(config.User),
    hostConfig,
    networkSettings: { Networks: networks },
    sizeRw: 0,
    sizeRootFs: 0,
    config,
  })
  return { Id: id, Warnings: warnings }
}
