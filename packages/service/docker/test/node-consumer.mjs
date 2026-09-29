import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { Agent, request } from "node:http"
import { createConnection } from "node:net"
import { resolve } from "node:path"
import { createServer } from "../dist/server.js"

// Independent client: Node's HTTP parser and raw bytes, no provider implementation imports.
// The server entry is used only to own fixture setup, scripted output and cleanup.
const until = async (predicate) => {
  const deadline = performance.now() + 2000
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("consumer fixture timeout")
    await new Promise((resolve) => setImmediate(resolve))
  }
}

for (const transport of ["tcp", "unix"]) {
  const dir = resolve(import.meta.dirname, "../../../../.mockingbird/docker-sockets")
  await mkdir(dir, { recursive: true })
  const socketPath = `${dir}/${crypto.randomUUID().slice(0, 8)}.sock`
  const server = await createServer({
    ...(transport === "unix" ? { socketPath } : {}),
    attachHandshake: { chunkBytes: 1 },
    attachStreams: { frameChunkBytes: 1 },
  })
  const endpoint = transport === "unix" ? { socketPath } : { host: server.host, port: server.port }
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  const sockets = new Set()
  const call = (method, path, body) =>
    new Promise((resolve, reject) => {
      const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
      const req = request(
        {
          ...endpoint,
          method,
          path,
          agent,
          headers: { "content-type": "application/json", "content-length": bytes.length },
        },
        (res) => {
          const chunks = []
          res.on("data", (chunk) => chunks.push(chunk))
          res.once("error", reject)
          res.once("aborted", () => reject(new Error("response aborted")))
          res.once("end", () => {
            const text = Buffer.concat(chunks).toString()
            try {
              resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null })
            } catch (error) {
              reject(error)
            }
          })
        },
      )
      req.once("socket", (socket) => sockets.add(socket))
      req.once("error", reject)
      req.setTimeout(2000, () => req.destroy(new Error("HTTP consumer timeout")))
      req.end(bytes)
    })
  const checked = async (method, path, body, status = 200) => {
    const response = await call(method, path, body)
    assert.equal(response.status, status, `${method} ${path}`)
    return response.body
  }
  const fault = (operation) =>
    checked("POST", "/__admin/faults", { preset: `docker_${operation}_accepted_drop` }, 201)
  const inspect = (name) => checked("GET", `/v1.52/containers/${name}/json`)
  const lost = async (method, path, body) => {
    await assert.rejects(call(method, path, body), { code: "ECONNRESET" })
  }
  let attached
  try {
    await checked(
      "POST",
      "/__admin/docker/seed",
      {
        images: [{ id: `sha256:${"b".repeat(64)}`, tags: ["synthetic"] }],
      },
      201,
    )
    await checked("GET", "/v1.52/version")
    assert.equal(sockets.size, 1, "sequential requests must retain the same HTTP connection")
    await fault("create")
    await lost("POST", "/v1.52/containers/create?name=worker", {
      Image: "synthetic",
      Cmd: ["worker"],
      OpenStdin: true,
    })
    const created = await inspect("worker")
    assert.match(created.Id, /^[0-9a-f]{64}$/)
    assert.equal(created.State.Status, "created")
    assert.equal(sockets.size, 2, "only explicit re-inspection opens another connection")
    await checked(
      "POST",
      "/v1.52/containers/create?name=worker",
      { Image: "synthetic", Cmd: ["worker"] },
      409,
    )
    const inventory = await checked("GET", "/v1.52/containers/json?all=1")
    assert.equal(inventory.length, 1)
    assert.equal(inventory[0].Id, created.Id)
    await fault("start")
    await lost("POST", `/v1.52/containers/${created.Id}/start`)
    assert.equal((await inspect("worker")).State.Running, true)

    // A raw duplex consumer owns the upgrade boundary, stdin and multiplexed output.
    attached = createConnection(transport === "unix" ? socketPath : endpoint)
    let wire = Buffer.alloc(0)
    let socketError
    attached.on("data", (chunk) => {
      wire = Buffer.concat([wire, chunk])
    })
    attached.on("error", (error) => {
      socketError = error
    })
    attached.setTimeout(2000, () => attached.destroy(new Error("attach consumer timeout")))
    attached.write(
      Buffer.concat([
        Buffer.from(
          `POST /v1.52/containers/${created.Id}/attach?stream=1&stdin=1&stdout=1&stderr=1 HTTP/1.1\r\nHost: docker.mock\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n`,
        ),
        Buffer.from([0, 255, 65]),
      ]),
    )
    await until(() => wire.includes("\r\n\r\n") || socketError)
    if (socketError) throw socketError
    const boundary = wire.indexOf("\r\n\r\n")
    assert.match(wire.subarray(0, boundary).toString(), /^HTTP\/1.1 101 UPGRADED\r\n/)
    assert.match(
      wire.subarray(0, boundary).toString(),
      /application\/vnd.docker.multiplexed-stream/,
    )
    wire = wire.subarray(boundary + 4)
    const [session] = server.attachments()
    assert.ok(session)
    const input = []
    await until(() => {
      input.push(Buffer.from(session.takeStdin()))
      return Buffer.concat(input).length >= 3
    })
    assert.deepEqual(Buffer.concat(input), Buffer.from([0, 255, 65]))
    await session.write("stdout", Buffer.from([0, 255]))
    await session.write("stderr", Buffer.from("err"))
    await until(() => wire.length >= 21 || socketError)
    if (socketError) throw socketError
    assert.deepEqual(
      wire,
      Buffer.from([1, 0, 0, 0, 0, 0, 0, 2, 0, 255, 2, 0, 0, 0, 0, 0, 0, 3, 101, 114, 114]),
    )
    attached.destroy()
    await until(() => session.closed)
    assert.equal(
      (await inspect("worker")).State.Running,
      true,
      "transport loss is not process exit",
    )

    // Each termination response can be lost after acceptance; inspection still sees execution.
    for (const operation of ["stop", "kill", "remove"]) {
      await fault(operation)
      const path =
        operation === "remove"
          ? `/v1.52/containers/${created.Id}?force=true`
          : `/v1.52/containers/${created.Id}/${operation}`
      await lost(operation === "remove" ? "DELETE" : "POST", path)
      assert.equal((await inspect("worker")).State.Running, true)
      await checked("POST", `/__admin/docker/containers/${created.Id}/complete`, { exitCode: 137 })
      if (operation === "remove") {
        await checked("GET", "/v1.52/containers/worker/json", undefined, 404)
        assert.deepEqual(await checked("GET", "/v1.52/containers/json?all=1"), [])
      } else {
        assert.equal((await inspect("worker")).State.ExitCode, 137)
        assert.deepEqual(await checked("POST", `/v1.52/containers/${created.Id}/wait`), {
          StatusCode: 137,
        })
        await checked("POST", `/v1.52/containers/${created.Id}/start`, undefined, 204)
      }
    }
    // Mock control evidence distinguishes an accepted drop from a pre-dispatch failure.
    const journal = await checked("GET", "/__admin/requests")
    const dropped = journal.requests.filter((entry) => entry.status === 0)
    assert.deepEqual(dropped.map((entry) => entry.operationId).sort(), [
      "ContainerCreate",
      "ContainerDelete",
      "ContainerKill",
      "ContainerStart",
      "ContainerStop",
    ])
    for (const entry of dropped) {
      assert.equal(entry.accepted, true)
      assert.equal(typeof entry.checkpoint, "string")
    }
    console.log(
      `${transport}: retained HTTP, accepted response loss, re-inspection and raw attach passed`,
    )
  } finally {
    attached?.destroy()
    agent.destroy()
    await server.close()
  }
}
