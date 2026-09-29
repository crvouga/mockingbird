import { pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { createServer } from "../dist/server.js"
import {
  attach,
  execution,
  imageDefaults,
  jsonRequest,
  owned,
  parseOptions,
  supportsApi,
} from "./oracle-client.mjs"

export const runOracle = async (options) => {
  const report = {
    oracle: "Docker Engine",
    expectedVersion: options.engineVersion,
    comparisonApi: "1.52",
    runId: options.runId,
    image: options.image,
    comparisons: [],
    cleanup: [],
    gaps: [
      "No daemon restart or live-restore scenario executed",
      "Transport response-loss evidence is synthetic and recorded separately in US-008/US-012",
      "No host enforcement, SDK or external consumer policy verification",
    ],
    passed: false,
  }
  // No default Docker context, environment variable, CLI or host socket is consulted.
  const real = options.endpoint
  const read = (endpoint, path) => jsonRequest(endpoint, "GET", path)
  const compare = (label, actual, modeled) => {
    const equal = isDeepStrictEqual(actual, modeled)
    report.comparisons.push({ label, actual, modeled, equal })
    if (!equal) throw new Error(`Comparison failed: ${label}`)
  }
  const requireStatus = (response, expected, label) => {
    if (response.status !== expected)
      throw new Error(`${label}: expected ${expected}, received ${response.status}`)
    return response.body
  }
  const intents = []
  let server
  const attachments = []
  try {
    const version = requireStatus(await read(real, "/version"), 200, "Engine version")
    report.version = {
      version: version.Version,
      api: version.ApiVersion,
      minimumApi: version.MinAPIVersion,
      os: version.Os,
      arch: version.Arch,
      gitCommit: version.GitCommit,
    }
    if (
      version.Version !== options.engineVersion ||
      !supportsApi(version) ||
      version.Os !== "linux"
    )
      throw new Error(
        "Oracle requires the explicitly selected Linux Engine version and API 1.52 support",
      )
    const image = requireStatus(
      await read(real, `/v1.52/images/${options.image}/json`),
      200,
      "Existing image",
    )
    if (image.Id !== options.image || image.Os !== "linux")
      throw new Error("Oracle image identity or OS mismatch")
    const defaults = imageDefaults(image)
    report.omittedImageMetadata = defaults.omitted
    report.imagePlatform = { os: image.Os, architecture: image.Architecture }
    // Reject collisions before any real mutation; never adopt preexisting resources.
    for (const scenario of ["attach", "stop", "kill"]) {
      const name = `${options.runId}-${scenario}`
      requireStatus(await read(real, `/v1.52/containers/${name}/json`), 404, "Ownership preflight")
    }
    server = await createServer()
    const mock = { host: server.host, port: server.port }
    requireStatus(
      await jsonRequest(mock, "POST", "/__admin/docker/seed", {
        images: [
          {
            id: image.Id,
            tags: [],
            config: defaults.config,
            platform: `${image.Os}/${image.Architecture ?? "amd64"}`,
          },
        ],
      }),
      201,
      "Mock image seed",
    )
    for (const scenario of ["attach", "stop", "kill"]) {
      const name = `${options.runId}-${scenario}`
      const intent = { name }
      // Track the unique create intent before I/O so an accepted-but-lost create is recoverable.
      intents.push(intent)
      const body = {
        Image: options.image,
        Cmd: [
          "/bin/sh",
          "-c",
          scenario === "attach"
            ? "read line; printf '%s\\n' \"$line\"; printf 'oracle-stderr\\n' >&2; exit 7"
            : "while :; do sleep 1; done",
        ],
        Entrypoint: [""],
        WorkingDir: "/",
        OpenStdin: true,
        Tty: false,
        Labels: { "mockingbird.oracle": options.runId },
        HostConfig: { NetworkMode: "none" },
      }
      const created = await jsonRequest(real, "POST", `/v1.52/containers/create?name=${name}`, body)
      if (created.status === 201 && /^[a-f0-9]{64}$/.test(created.body?.Id ?? ""))
        intent.id = created.body.Id
      if (created.status !== 201) intents.pop() // A definitive rejected create conveys no ownership.
      requireStatus(created, 201, "Real create")
      if (!intent.id) throw new Error("Real create returned invalid container ID")
      const modeled = await jsonRequest(mock, "POST", `/v1.52/containers/create?name=${name}`, body)
      compare(`${scenario}: create status`, created.status, modeled.status)
      const mockId = requireStatus(modeled, 201, "Mock create").Id
      const realPath = `/v1.52/containers/${intent.id}`
      const mockPath = `/v1.52/containers/${mockId}`
      const inspect = async () => {
        const actual = requireStatus(await read(real, `${realPath}/json`), 200, "Real inspect")
        if (!owned(actual, intent, options)) throw new Error("Container ownership changed")
        const simulated = requireStatus(await read(mock, `${mockPath}/json`), 200, "Mock inspect")
        compare(`${scenario}: execution`, execution(actual), execution(simulated))
      }
      await inspect()
      const started = await jsonRequest(real, "POST", `${realPath}/start`)
      const modeledStart = await jsonRequest(mock, "POST", `${mockPath}/start`)
      compare(`${scenario}: start status`, started.status, modeledStart.status)
      requireStatus(started, 204, "Real start")
      requireStatus(modeledStart, 204, "Mock start")
      await inspect()
      if (scenario === "attach") {
        const actual = await attach(real, intent.id)
        attachments.push(actual)
        const simulated = await attach(mock, mockId)
        attachments.push(simulated)
        compare("attach: upgrade", actual.headers, simulated.headers)
        actual.socket.write("oracle-probe\n")
        simulated.socket.write("oracle-probe\n")
        const [handle] = server.attachments()
        if (!handle) throw new Error("Missing synthetic attachment")
        let input = Buffer.alloc(0)
        const deadline = performance.now() + 2000
        while (!input.includes("\n")) {
          input = Buffer.concat([input, Buffer.from(handle.takeStdin())])
          if (performance.now() > deadline) throw new Error("Synthetic stdin timeout")
          await new Promise((resolve) => setImmediate(resolve))
        }
        compare("attach: stdin", "oracle-probe\n", input.toString())
        await handle.write("stdout", Buffer.from("oracle-probe\n"))
        await handle.write("stderr", Buffer.from("oracle-stderr\n"))
        requireStatus(
          await jsonRequest(mock, "POST", `/__admin/docker/containers/${mockId}/complete`, {
            exitCode: 7,
          }),
          200,
          "Mock completion",
        )
        compare(
          "attach: normalized channel bytes (base64)",
          await actual.done,
          await simulated.done,
        )
      } else {
        const suffix = scenario === "stop" ? "/stop?t=0" : "/kill?signal=KILL"
        const simulated = jsonRequest(mock, "POST", `${mockPath}${suffix}`)
        void simulated.catch(() => {})
        const deadline = performance.now() + 2000
        while (server.runtime.instance().lifecycle.pending === 0) {
          if (performance.now() > deadline)
            throw new Error("Synthetic termination was not accepted")
          await new Promise((resolve) => setImmediate(resolve))
        }
        const actual = await jsonRequest(real, "POST", `${realPath}${suffix}`)
        requireStatus(actual, 204, "Real termination")
        requireStatus(
          await jsonRequest(mock, "POST", `/__admin/docker/containers/${mockId}/complete`, {
            exitCode: 137,
          }),
          200,
          "Mock termination",
        )
        compare(`${scenario}: termination status`, actual.status, (await simulated).status)
      }
      const actualWait = requireStatus(
        await jsonRequest(real, "POST", `${realPath}/wait`),
        200,
        "Real wait",
      )
      const mockWait = requireStatus(
        await jsonRequest(mock, "POST", `${mockPath}/wait`),
        200,
        "Mock wait",
      )
      compare(`${scenario}: wait status code`, actualWait.StatusCode, mockWait.StatusCode)
      await inspect()
      // Recheck exact identity immediately before deleting this run's known stopped container.
      const beforeRemove = requireStatus(
        await read(real, `${realPath}/json`),
        200,
        "Removal ownership",
      )
      if (!owned(beforeRemove, intent, options)) throw new Error("Removal ownership mismatch")
      const removed = await jsonRequest(real, "DELETE", realPath)
      const modeledRemove = await jsonRequest(mock, "DELETE", mockPath)
      compare(`${scenario}: remove status`, removed.status, modeledRemove.status)
      requireStatus(removed, 204, "Real remove")
      requireStatus(modeledRemove, 204, "Mock remove")
      const absent = await read(real, `${realPath}/json`)
      const modeledAbsent = await read(mock, `${mockPath}/json`)
      compare(`${scenario}: removed inspection`, absent.status, modeledAbsent.status)
      requireStatus(absent, 404, "Real removed inspection")
      requireStatus(modeledAbsent, 404, "Mock removed inspection")
    }
    report.passed = true
  } catch (error) {
    // Record our own diagnostics; remote response bodies and credentials are never logged.
    report.error = error instanceof Error ? error.message : "Oracle execution failed"
  } finally {
    for (const attachment of attachments) attachment.socket.destroy()
    for (const intent of intents) {
      try {
        const found = await read(real, `/v1.52/containers/${intent.id ?? intent.name}/json`)
        if (found.status === 404) {
          report.cleanup.push({ name: intent.name, status: "absent" })
          continue
        }
        if (found.status !== 200 || !owned(found.body, intent, options)) {
          report.passed = false
          report.cleanup.push({
            name: intent.name,
            status: "failed",
            reason: "Ownership not proven; cleanup refused",
          })
          continue
        }
        const removed = await jsonRequest(
          real,
          "DELETE",
          `/v1.52/containers/${found.body.Id}?force=true`,
        )
        requireStatus(removed, 204, "Owned cleanup")
        report.cleanup.push({ name: intent.name, status: "removed" })
      } catch (error) {
        report.passed = false
        report.cleanup.push({
          name: intent.name,
          status: "failed",
          reason: error instanceof Error ? error.message : "Cleanup failed",
        })
      }
    }
    await server?.close()
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseOptions(process.argv.slice(2))
    const report = await runOracle(options)
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.passed ? 0 : 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid oracle invocation")
    process.exitCode = 1
  }
}
