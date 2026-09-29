import { jsonRes } from "@crvouga/mockingbird-service"
import {
  type ContainerRecord,
  DockerInputError,
  type DockerState,
  isRunning,
  record,
  statuses,
  zeroTime,
} from "./state.js"

export const booleanQuery = (url: URL, key: string) => {
  // Pinned httputils.BoolValue treats every other nonempty value as true.
  const value = (url.searchParams.get(key) ?? "").trim().toLowerCase()
  return !["", "0", "no", "false", "none"].includes(value)
}
export const version = () => ({
  Version: "29.1.0",
  ApiVersion: "1.52",
  MinAPIVersion: "1.44",
  GitCommit: "710302e",
  GoVersion: "go1.25.4",
  Os: "linux",
  Arch: "amd64",
  KernelVersion: "mockingbird-simulated",
  BuildTime: "2025-11-14T00:00:00.000000000+00:00",
  Experimental: false,
  Platform: { Name: "Mockingbird simulated Docker Engine" },
  Components: [
    { Name: "Engine", Version: "29.1.0", Details: { ApiVersion: "1.52", MinAPIVersion: "1.44" } },
  ],
})
export const info = (state: DockerState, now: () => number) => {
  const containers = state.containers.list().map((c) => c.value)
  return {
    ID: "mockingbird-synthetic-daemon",
    Name: "mockingbird-docker",
    ServerVersion: "29.1.0",
    Containers: containers.length,
    ContainersRunning: containers.filter((c) => isRunning(c) && c.status !== "paused").length,
    ContainersPaused: containers.filter((c) => c.status === "paused").length,
    ContainersStopped: containers.filter((c) => !isRunning(c)).length,
    Images: state.images.list().length,
    Driver: "overlay2",
    OSType: "linux",
    Architecture: "x86_64",
    OperatingSystem: "Mockingbird simulation (no host attestation)",
    KernelVersion: "mockingbird-simulated",
    DockerRootDir: state.daemon().rootless
      ? "/home/synthetic/.local/share/docker"
      : "/var/lib/docker",
    SecurityOptions: state.daemon().rootless ? ["name=rootless"] : [],
    SystemTime: new Date(now()).toISOString(),
    NCPU: 1,
    MemTotal: 1_073_741_824,
    Labels: ["mockingbird.simulated=true"],
    Warnings: ["Simulated metadata; no host isolation is enforced."],
  }
}
export const inspect = (c: ContainerRecord, size: boolean) => ({
  Id: c.id,
  Name: `/${c.name}`,
  Image: c.imageId,
  Created: c.created,
  Path: [...c.entrypoint, ...c.cmd][0] ?? "",
  Args: [...c.entrypoint, ...c.cmd].slice(1),
  State: {
    Status: c.status,
    Running: isRunning(c),
    Paused: c.status === "paused",
    Restarting: c.status === "restarting",
    OOMKilled: false,
    Dead: c.status === "dead",
    Pid: 0,
    ExitCode: c.exitCode,
    Error: "",
    StartedAt: c.startedAt,
    FinishedAt: c.finishedAt,
  },
  Config: {
    Image: c.image,
    Labels: c.labels,
    Cmd: c.cmd,
    Entrypoint: c.entrypoint,
    Env: c.env,
    WorkingDir: c.workingDir,
    User: c.user,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    ...c.config,
  },
  HostConfig: c.hostConfig,
  NetworkSettings: c.networkSettings,
  Mounts: [],
  ...(size ? { SizeRw: c.sizeRw, SizeRootFs: c.sizeRootFs } : {}),
})
const nameMatcher = (value: string) => {
  // Deliberately bounded RE2-compatible subset; avoid executing arbitrary JS regex.
  if (
    !/^[a-zA-Z0-9_./*^$-]*$/.test(value) ||
    (value.match(/\.\*/g) ?? []).length > 1 ||
    /(^|[^.])\*/.test(value) ||
    /[^$]\$./.test(value)
  )
    throw new DockerInputError(
      501,
      "Mockingbird: name regex outside supported literal/anchor/single .* subset",
    )
  try {
    return new RegExp(value)
  } catch {
    throw new DockerInputError(400, "invalid name filter")
  }
}
const elapsed = (milliseconds: number) => {
  const seconds = Math.trunc(milliseconds / 1000)
  if (seconds < 1) return "Less than a second"
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`
  const minutes = Math.trunc(seconds / 60)
  if (minutes === 1) return "About a minute"
  if (minutes < 60) return `${minutes} minutes`
  const hours = Math.trunc(milliseconds / 3_600_000 + 0.5)
  if (hours === 1) return "About an hour"
  if (hours < 48) return `${hours} hours`
  if (hours < 336) return `${Math.trunc(hours / 24)} days`
  if (hours < 1440) return `${Math.trunc(hours / 168)} weeks`
  if (hours < 17520) return `${Math.trunc(hours / 720)} months`
  return `${Math.trunc(milliseconds / 31_536_000_000)} years`
}
const statusText = (c: ContainerRecord, now: number) => {
  const sinceStart = elapsed(now - Date.parse(c.startedAt))
  const sinceExit = elapsed(now - Date.parse(c.finishedAt))
  switch (c.status) {
    case "running":
      return `Up ${sinceStart}`
    case "paused":
      return `Up ${sinceStart} (Paused)`
    case "restarting":
      return `Restarting (${c.exitCode}) ${sinceExit} ago`
    case "exited":
      return `Exited (${c.exitCode}) ${sinceExit} ago`
    case "created":
      return "Created"
    case "dead":
      return "Dead"
    case "removing":
      return "Removal In Progress"
  }
}
export const list = (state: DockerState, url: URL, now: () => number) => {
  const all = booleanQuery(url, "all")
  const size = booleanQuery(url, "size")
  const rawLimit = url.searchParams.get("limit") ?? ""
  if (rawLimit && !/^[+-]?\d+$/.test(rawLimit)) throw new DockerInputError(400, "invalid limit")
  const limit = rawLimit ? Number(rawLimit) : 0
  if (!Number.isSafeInteger(limit)) throw new DockerInputError(400, "invalid limit")
  let parsed: unknown = {}
  try {
    parsed = JSON.parse(url.searchParams.get("filters") || "{}")
  } catch {
    throw new DockerInputError(400, "invalid filters JSON")
  }
  if (parsed === null) parsed = {}
  if (!record(parsed)) throw new DockerInputError(400, "filters must be an object")
  const filters: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!["id", "name", "status", "label", "exited"].includes(key))
      throw new DockerInputError(501, `Mockingbird: unsupported filter ${key}`)
    // Engine accepts both current boolean sets and legacy string arrays.
    const values =
      value === null
        ? []
        : record(value) && Object.values(value).every((v) => typeof v === "boolean")
          ? Object.keys(value)
          : value
    if (!Array.isArray(values) || !values.every((v) => typeof v === "string"))
      throw new DockerInputError(400, "filter values must be strings")
    filters[key] = values
  }
  for (const status of filters.status ?? [])
    if (!statuses.includes(status as never))
      throw new DockerInputError(400, `invalid filter 'status=${status}'`)
  for (const exit of filters.exited ?? [])
    if (!/^[+-]?\d+$/.test(exit) || !Number.isSafeInteger(Number(exit)))
      throw new DockerInputError(400, `invalid filter 'exited=${exit}'`)
  const names = (filters.name ?? []).map(nameMatcher)
  const matches = state.containers
    .list()
    .filter(({ value: c }) => {
      if (!all && limit <= 0 && !filters.status?.length && !isRunning(c)) return false
      if (filters.status?.length && !filters.status.includes(c.status)) return false
      if (
        filters.id?.length &&
        !filters.id.some(
          (id) =>
            id.length > 0 &&
            c.id.startsWith(id) &&
            state.containers.list().filter((other) => other.id.startsWith(id)).length === 1,
        )
      )
        return false
      if (
        names.length &&
        !names.some((pattern) => pattern.test(c.name) || pattern.test(`/${c.name}`))
      )
        return false
      if (
        filters.exited?.length &&
        (isRunning(c) ||
          c.startedAt === zeroTime ||
          !filters.exited.some((exit) => Number(exit) === c.exitCode))
      )
        return false
      return (filters.label ?? []).every((label) => {
        const at = label.indexOf("=")
        return at < 0
          ? Object.hasOwn(c.labels, label)
          : c.labels[label.slice(0, at)] === label.slice(at + 1)
      })
    })
    .sort((a, b) => b.value.created.localeCompare(a.value.created) || b.seq - a.seq)
  return jsonRes(
    200,
    (limit > 0 ? matches.slice(0, limit) : matches).map(({ value: c }) => ({
      Id: c.id,
      Names: [`/${c.name}`],
      Image: c.image,
      ImageID: c.imageId,
      Command: [...c.entrypoint, ...c.cmd].join(" "),
      Created: Math.floor(Date.parse(c.created) / 1000),
      State: c.status,
      Status: statusText(c, now()),
      Labels: c.labels,
      Ports: [],
      HostConfig: { NetworkMode: c.hostConfig.NetworkMode ?? "default" },
      NetworkSettings: c.networkSettings,
      Mounts: [],
      ...(size ? { SizeRw: c.sizeRw, SizeRootFs: c.sizeRootFs } : {}),
    })),
  )
}
