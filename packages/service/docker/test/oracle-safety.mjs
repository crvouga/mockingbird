import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import { runOracle } from "../scripts/docker-oracle.mjs"
import {
  attach,
  imageDefaults,
  owned,
  parseEndpoint,
  parseOptions,
  supportsApi,
} from "../scripts/oracle-client.mjs"

const image = `sha256:${"b".repeat(64)}`
const runId = `mb-oracle-${"a".repeat(32)}`
const args = [
  "--endpoint",
  "http://127.0.0.1:43210",
  "--engine-version",
  "29.8.0",
  "--image",
  image,
  "--run-id",
  runId,
  "--allow-lifecycle",
]
const version = {
  Version: "29.8.0",
  ApiVersion: "1.56",
  MinAPIVersion: "1.40",
  Os: "linux",
  Arch: "amd64",
}

const fixture = async (handler, upgrade) => {
  const calls = []
  const sockets = new Set()
  const server = createServer((req, res) => {
    calls.push({ method: req.method, path: req.url })
    const response = handler(req)
    res.writeHead(response.status, { "content-type": "application/json" })
    res.end(JSON.stringify(response.body))
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  if (upgrade) server.on("upgrade", upgrade)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    calls,
    endpoint: { host: "127.0.0.1", port: server.address().port },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

test("oracle options require explicit endpoint, exact version, immutable image, ownership and approval", () => {
  assert.equal(parseOptions(args).image, image)
  for (const key of ["--endpoint", "--engine-version", "--image", "--run-id"]) {
    const missing = args.slice()
    missing.splice(missing.indexOf(key), 2)
    assert.throws(() => parseOptions(missing))
  }
  assert.throws(() => parseOptions(args.slice(0, -1)), /allow-lifecycle/)
  assert.throws(() => parseOptions([...args, "--endpoint", "http://127.0.0.1:1"]), /duplicate/)
  assert.throws(
    () => parseOptions(args.map((value) => (value === "29.8.0" ? "latest" : value))),
    /engine-version/,
  )
  assert.throws(
    () => parseOptions(args.map((value) => (value === image ? "alpine:latest" : value))),
    /immutable/,
  )
  for (const endpoint of [
    undefined,
    "http://user:secret@localhost",
    "http://example.com",
    "http://localhost/?secret=x",
    "http://localhost/prefix",
    "file:///var/run/docker.sock",
  ])
    assert.throws(() => parseEndpoint(endpoint))
  assert.deepEqual(parseEndpoint("unix:///project/owned.sock"), {
    socketPath: "/project/owned.sock",
  })
})

test("cleanup ownership requires exact label, name, immutable image and returned id", () => {
  const options = parseOptions(args)
  const intent = { name: `${runId}-attach`, id: "c".repeat(64) }
  const record = {
    Id: intent.id,
    Name: `/${intent.name}`,
    Image: image,
    Config: { Labels: { "mockingbird.oracle": runId } },
  }
  assert.equal(owned(record, intent, options), true)
  for (const change of [
    { Id: "d".repeat(64) },
    { Name: "/unrelated" },
    { Image: `sha256:${"e".repeat(64)}` },
    { Config: { Labels: {} } },
  ])
    assert.equal(owned({ ...record, ...change }, intent, options), false)
})

for (const rejection of ["version", "image", "collision", "create409"]) {
  test(`preflight/ownership rejection ${rejection} never deletes or adopts resources`, async () => {
    const f = await fixture((req) => {
      if (req.url === "/version")
        return {
          status: 200,
          body: { ...version, ...(rejection === "version" ? { Version: "29.7.2" } : {}) },
        }
      if (req.url.startsWith("/v1.52/images/"))
        return {
          status: 200,
          body: {
            Id: rejection === "image" ? `sha256:${"f".repeat(64)}` : image,
            Os: "linux",
            Architecture: "amd64",
            Config: {},
          },
        }
      if (req.method === "POST") return { status: 409, body: { message: "Conflict" } }
      return { status: rejection === "collision" ? 200 : 404, body: {} }
    })
    try {
      const report = await runOracle({ ...parseOptions(args), endpoint: f.endpoint })
      assert.equal(report.passed, false)
      assert.equal(
        f.calls.some((call) => call.method === "DELETE"),
        false,
      )
      assert.equal(
        f.calls.filter((call) => call.method === "POST").length,
        rejection === "create409" ? 1 : 0,
      )
      assert.deepEqual(report.cleanup, [])
    } finally {
      await f.close()
    }
  })
}

for (const malformed of [false, true]) {
  test(`attach decoder ${malformed ? "rejects truncated frames" : "normalizes channel bytes across frame splits"}`, async () => {
    const f = await fixture(
      () => ({ status: 404, body: {} }),
      (_req, socket) => {
        socket.write(
          "HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\n\r\n",
        )
        for (const byte of [1, 0, 0, 0, 0, 0, 0, 2, 65, ...(malformed ? [] : [66])])
          socket.write(Buffer.from([byte]))
        socket.end()
      },
    )
    try {
      const connection = await attach(f.endpoint, "c".repeat(64))
      if (malformed) await assert.rejects(connection.done, /Truncated/)
      else
        assert.deepEqual(await connection.done, {
          stdout: Buffer.from("AB").toString("base64"),
          stderr: "",
        })
    } finally {
      await f.close()
    }
  })
}

for (const retainOwnership of [true, false]) {
  test(`failed run cleanup ${retainOwnership ? "removes only its verified container" : "refuses changed ownership"}`, async () => {
    let created = false
    const id = "c".repeat(64)
    const f = await fixture((req) => {
      if (req.url === "/version") return { status: 200, body: version }
      if (req.url.startsWith("/v1.52/images/"))
        return { status: 200, body: { Id: image, Os: "linux", Config: {} } }
      if (req.url.startsWith("/v1.52/containers/create")) {
        created = true
        return { status: 201, body: { Id: id } }
      }
      if (req.method === "POST") return { status: 500, body: { message: "Injected start failure" } }
      if (req.method === "DELETE") return { status: 204, body: null }
      return created
        ? {
            status: 200,
            body: {
              Id: id,
              Name: `/${runId}-attach`,
              Image: image,
              Config: { Labels: { "mockingbird.oracle": retainOwnership ? runId : "unrelated" } },
              State: { Status: "created", Running: false, ExitCode: 0 },
            },
          }
        : { status: 404, body: {} }
    })
    try {
      const report = await runOracle({ ...parseOptions(args), endpoint: f.endpoint })
      assert.equal(report.passed, false)
      const removed = f.calls.filter((call) => call.method === "DELETE")
      assert.deepEqual(
        removed,
        retainOwnership ? [{ method: "DELETE", path: `/v1.52/containers/${id}?force=true` }] : [],
      )
      assert.equal(report.cleanup[0].status, retainOwnership ? "removed" : "failed")
    } finally {
      await f.close()
    }
  })
}

for (const divergent of [false, true]) {
  test(`scripted protocol fixture ${divergent ? "exposes output divergence and cleans up" : "exercises the complete oracle flow"}`, async () => {
    const records = new Map()
    let sequence = 0
    const f = await fixture(
      (req) => {
        const url = new URL(req.url, "http://fixture")
        if (url.pathname === "/version") return { status: 200, body: version }
        if (url.pathname.startsWith("/v1.52/images/"))
          return {
            status: 200,
            body: { Id: image, Os: "linux", Architecture: "amd64", Config: {} },
          }
        if (url.pathname === "/v1.52/containers/create") {
          const id = (++sequence).toString(16).padStart(64, "0")
          records.set(id, {
            Id: id,
            Name: `/${url.searchParams.get("name")}`,
            Image: image,
            Config: { Labels: { "mockingbird.oracle": runId } },
            State: { Status: "created", Running: false, ExitCode: 0 },
          })
          return { status: 201, body: { Id: id, Warnings: [] } }
        }
        const match = /^\/v1.52\/containers\/([^/]+)(?:\/(.+))?$/.exec(url.pathname)
        const record =
          match &&
          [...records.values()].find((item) => item.Id === match[1] || item.Name === `/${match[1]}`)
        if (!record) return { status: 404, body: { message: "No such container" } }
        if (req.method === "DELETE") {
          records.delete(record.Id)
          return { status: 204, body: null }
        }
        switch (match[2]) {
          case "json":
            return { status: 200, body: record }
          case "start":
            record.State = { Status: "running", Running: true, ExitCode: 0 }
            return { status: 204, body: null }
          case "stop":
          case "kill":
            record.State = { Status: "exited", Running: false, ExitCode: 137 }
            return { status: 204, body: null }
          case "wait":
            return { status: 200, body: { StatusCode: record.State.ExitCode } }
          default:
            return { status: 404, body: {} }
        }
      },
      (req, socket) => {
        const id = new URL(req.url, "http://fixture").pathname.split("/")[3]
        socket.write(
          "HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\n\r\n",
        )
        let input = ""
        socket.on("data", (chunk) => {
          input += chunk.toString()
          if (!input.includes("\n")) return
          assert.equal(input, "oracle-probe\n")
          for (const [channel, text] of [
            [1, "oracle-probe\n"],
            [2, divergent ? "wrong\n" : "oracle-stderr\n"],
          ]) {
            const payload = Buffer.from(text)
            const header = Buffer.alloc(8)
            header[0] = channel
            header.writeUInt32BE(payload.length, 4)
            socket.write(header)
            socket.write(payload)
          }
          records.get(id).State = { Status: "exited", Running: false, ExitCode: 7 }
          socket.end()
        })
      },
    )
    try {
      const report = await runOracle({ ...parseOptions(args), endpoint: f.endpoint })
      assert.equal(report.passed, !divergent, JSON.stringify(report))
      assert.equal(records.size, 0)
      if (divergent) {
        assert.match(report.error, /normalized channel bytes/)
        assert.equal(report.cleanup[0].status, "removed")
      } else {
        assert.equal(report.comparisons.length, 29)
        assert.equal(
          report.comparisons.every((item) => item.equal),
          true,
        )
        assert.equal(report.cleanup.length, 3)
        assert.equal(
          report.cleanup.every((item) => item.status === "absent"),
          true,
        )
      }
    } finally {
      await f.close()
    }
  })
}

test("selected API must lie within the daemon's advertised range", () => {
  assert.equal(supportsApi(version), true)
  for (const change of [
    { MinAPIVersion: "1.53" },
    { ApiVersion: "1.51" },
    { ApiVersion: undefined },
    { MinAPIVersion: "invalid" },
  ])
    assert.equal(supportsApi({ ...version, ...change }), false)
})

test("image defaults reject extra execution/storage and expose omitted metadata", () => {
  assert.throws(() => imageDefaults({ Config: { Volumes: { "/data": {} } } }), /volumes/)
  assert.throws(
    () => imageDefaults({ Config: { Healthcheck: { Test: ["CMD", "unexpected"] } } }),
    /healthcheck/,
  )
  assert.deepEqual(imageDefaults({ Config: { Cmd: ["sh"], ExposedPorts: { "80/tcp": {} } } }), {
    config: { Cmd: ["sh"] },
    omitted: ["ExposedPorts"],
  })
})
