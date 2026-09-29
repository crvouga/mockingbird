import { request } from "node:http"

export const parseOptions = (args) => {
  const options = {}
  const names = new Set(["endpoint", "engine-version", "image", "run-id"])
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, "")
    if (args[i] === "--allow-lifecycle") {
      if (options.allowLifecycle) throw new Error("Duplicate lifecycle authorization")
      options.allowLifecycle = true
    } else {
      if (!args[i].startsWith("--") || !names.has(key) || options[key] !== undefined)
        throw new Error("Unknown or duplicate oracle option")
      const value = args[++i]
      if (!value || value.startsWith("--")) throw new Error(`Missing ${key}`)
      options[key] = value
    }
  }
  if (!options.allowLifecycle) throw new Error("Explicit --allow-lifecycle is required")
  if (!/^\d+\.\d+\.\d+$/.test(options["engine-version"] ?? ""))
    throw new Error("Explicit numeric --engine-version is required")
  if (!/^sha256:[a-f0-9]{64}$/.test(options.image ?? ""))
    throw new Error("Existing immutable --image sha256 ID is required")
  if (!/^mb-oracle-[a-f0-9]{32}$/.test(options["run-id"] ?? ""))
    throw new Error("Unique --run-id mb-oracle-<32 lowercase hex characters> is required")
  return {
    endpoint: parseEndpoint(options.endpoint),
    engineVersion: options["engine-version"],
    image: options.image,
    runId: options["run-id"],
  }
}

export const parseEndpoint = (value) => {
  if (typeof value !== "string" || !value)
    throw new Error("Explicit --endpoint is required; no default daemon is used")
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error("Invalid oracle endpoint")
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Endpoint credentials, query and fragment are not supported")
  if (url.protocol === "unix:" && !url.host && url.pathname.startsWith("/") && url.pathname !== "/")
    return { socketPath: decodeURIComponent(url.pathname) }
  if (
    url.protocol === "http:" &&
    ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) &&
    url.pathname === "/"
  )
    return { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 80) }
  throw new Error("Use an explicit unix:///absolute/socket or loopback http://host:port endpoint")
}

export const jsonRequest = (endpoint, method, path, body) =>
  new Promise((resolve, reject) => {
    const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
    const req = request(
      {
        ...endpoint,
        method,
        path,
        agent: false,
        headers: {
          "content-type": "application/json",
          "content-length": bytes.length,
        },
      },
      (res) => {
        const chunks = []
        let size = 0
        res.on("data", (chunk) => {
          size += chunk.length
          if (size > 1024 * 1024) res.destroy(new Error("Oracle response exceeds 1 MiB"))
          else chunks.push(chunk)
        })
        res.once("error", reject)
        res.once("aborted", () => reject(new Error("Oracle response aborted")))
        res.once("end", () => {
          try {
            const text = Buffer.concat(chunks).toString()
            resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null })
          } catch {
            reject(new Error("Oracle response is not JSON"))
          }
        })
      },
    )
    req.once("error", reject)
    req.setTimeout(10_000, () => req.destroy(new Error("Oracle HTTP timeout")))
    req.end(bytes)
  })

export const attach = (endpoint, id) =>
  new Promise((resolve, reject) => {
    const req = request({
      ...endpoint,
      method: "POST",
      agent: false,
      path: `/v1.52/containers/${id}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
      headers: { connection: "Upgrade", upgrade: "tcp", "content-length": "0" },
    })
    req.once("error", reject)
    req.setTimeout(10_000, () => req.destroy(new Error("Oracle upgrade timeout")))
    req.once("response", (res) => {
      res.resume()
      reject(new Error(`Attach did not upgrade: ${res.statusCode}`))
    })
    req.once("upgrade", (res, socket, head) => {
      let pending = Buffer.alloc(0)
      const output = { stdout: [], stderr: [] }
      let total = 0
      const done = new Promise((finish, fail) => {
        let ended = false
        const receive = (bytes) => {
          total += bytes.length
          if (total > 1024 * 1024) {
            socket.destroy(new Error("Oracle stream exceeds 1 MiB"))
            return
          }
          pending = Buffer.concat([pending, bytes])
          while (pending.length >= 8) {
            const channel = pending[0]
            const size = pending.readUInt32BE(4)
            if (
              ![1, 2].includes(channel) ||
              pending.subarray(1, 4).some((byte) => byte !== 0) ||
              size > 1024 * 1024
            ) {
              socket.destroy(new Error("Invalid Docker multiplexed frame"))
              return
            }
            if (pending.length < 8 + size) return
            output[channel === 1 ? "stdout" : "stderr"].push(pending.subarray(8, 8 + size))
            pending = pending.subarray(8 + size)
          }
        }
        socket.on("data", receive)
        socket.once("error", fail)
        socket.once("end", () => {
          ended = true
          socket.end()
          if (pending.length) fail(new Error("Truncated Docker frame"))
          else
            finish({
              stdout: Buffer.concat(output.stdout).toString("base64"),
              stderr: Buffer.concat(output.stderr).toString("base64"),
            })
        })
        socket.once("close", () => {
          if (!ended) fail(new Error("Attach closed without EOF"))
        })
        socket.setTimeout(10_000, () => socket.destroy(new Error("Oracle stream timeout")))
        if (head.length) receive(head)
      })
      // Attach may fail before the caller reaches its comparison; retain rejection for await.
      void done.catch(() => {})
      resolve({
        socket,
        done,
        headers: {
          status: res.statusCode,
          type: res.headers["content-type"],
          upgrade: res.headers.upgrade,
        },
      })
    })
    req.end()
  })

export const owned = (record, intent, options) =>
  record?.Name === `/${intent.name}` &&
  record.Image === options.image &&
  record.Config?.Labels?.["mockingbird.oracle"] === options.runId &&
  /^[a-f0-9]{64}$/.test(record.Id ?? "") &&
  (!intent.id || record.Id === intent.id)

export const execution = (record) => ({
  status: record.State.Status,
  running: record.State.Running,
  exitCode: record.State.ExitCode,
})

export const supportsApi = (version, target = "1.52") => {
  const parse = (value) =>
    typeof value === "string" && /^\d+\.\d+$/.test(value) ? value.split(".").map(Number) : null
  const min = parse(version.MinAPIVersion),
    max = parse(version.ApiVersion),
    selected = parse(target)
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1]
  return Boolean(
    min && max && selected && compare(min, selected) <= 0 && compare(selected, max) <= 0,
  )
}

export const imageDefaults = (image) => {
  const config = image.Config ?? {}
  if (Object.keys(config.Volumes ?? {}).length)
    throw new Error("Oracle image must not declare volumes")
  if (config.Healthcheck?.Test?.length && config.Healthcheck.Test[0] !== "NONE")
    throw new Error("Oracle image must not declare an active healthcheck")
  const fields = [
    "Cmd",
    "Entrypoint",
    "Env",
    "WorkingDir",
    "User",
    "Labels",
    "StopSignal",
    "StopTimeout",
    "AttachStdin",
    "AttachStdout",
    "AttachStderr",
    "OpenStdin",
    "StdinOnce",
    "Tty",
    "NetworkDisabled",
    "Hostname",
    "Domainname",
    "Image",
  ]
  return {
    config: Object.fromEntries(Object.entries(config).filter(([key]) => fields.includes(key))),
    omitted: Object.keys(config)
      .filter((key) => !fields.includes(key))
      .sort(),
  }
}
