import { expect, test } from "bun:test"
import { createServer, type DockerServer } from "./src/server.js"
import { attachClient } from "./test/attach-client.js"

const id = "a".repeat(64)
const seed = (server: DockerServer, config: Record<string, unknown> = {}) => {
  const api = server.runtime.instance()
  api.state.seed({
    images: [{ id: `sha256:${"b".repeat(64)}`, tags: ["synthetic"] }],
    containers: [{ id, name: "worker", image: "synthetic", status: "running" }],
  })
  api.state.containers.update(id, { ...api.state.find(id), config })
}

test("scripted stdout/stderr preserve frame boundaries across byte-sized writes", async () => {
  const server = await createServer({ attachStreams: { frameChunkBytes: 1 } })
  seed(server)
  const client = await attachClient(server, id)
  try {
    const [session] = server.attachments()
    if (!session) throw new Error("missing attachment")
    await Promise.all([
      session.write("stdout", new Uint8Array([0, 255, 7])),
      session.write("stderr", new TextEncoder().encode("error")),
      session.write("stdout", new Uint8Array()),
    ])
    expect(await client.read()).toEqual({ channel: 1, data: Buffer.from([0, 255, 7]) })
    expect(await client.read()).toEqual({ channel: 2, data: Buffer.from("error") })
    expect(await client.read()).toEqual({ channel: 1, data: Buffer.alloc(0) })
    await session.end()
    await client.ended
    expect(server.runtime.instance().state.find(id).status).toBe("running")
  } finally {
    client.close()
    await server.close()
  }
})

test("checkout closes live handles and stale output cannot target a restored container", async () => {
  const server = await createServer()
  seed(server)
  const before = server.runtime.checkpoint()
  const client = await attachClient(server, id)
  try {
    const [session] = server.attachments()
    if (!session) throw new Error("missing attachment")
    server.runtime.checkout(before.id)
    await client.ended
    await expect(session.write("stdout", new Uint8Array([1]))).rejects.toThrow()
    expect(server.attachments()).toHaveLength(0)
    expect(server.runtime.instance().state.find(id).status).toBe("running")
  } finally {
    client.close()
    await server.close()
  }
})

const until = async (predicate: () => boolean) => {
  const deadline = performance.now() + 1000
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("fixture condition timeout")
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

test("raw stdin read-ahead and later bytes respect OpenStdin and stay out of journals", async () => {
  const server = await createServer()
  seed(server, { OpenStdin: true, StdinOnce: true })
  const client = await attachClient(server, id, "stdin=1&stdout=1", Buffer.from([0, 255, 65]))
  try {
    const [session] = server.attachments()
    if (!session) throw new Error("missing attachment")
    expect(Buffer.from(session.takeStdin())).toEqual(Buffer.from([0, 255, 65]))
    client.socket.write(Buffer.from("later"))
    let input = Buffer.alloc(0)
    await until(() => {
      input = Buffer.concat([input, session.takeStdin()])
      return input.length === 5
    })
    expect(input.toString()).toBe("later")
    client.socket.end()
    await until(() => session.stdinClosed)
    expect(server.runtime.instance().state.find(id).stdinClosed).toBe(true)
    expect(server.runtime.instance().state.find(id).status).toBe("running")
    await session.write("stdout", Buffer.from("after input EOF"))
    expect((await client.read()).data.toString()).toBe("after input EOF")
    expect(JSON.stringify(server.runtime.journal.list())).not.toContain("later")
    server.runtime.instance().lifecycle.complete(id, { exitCode: 0 })
    await client.ended
  } finally {
    client.close()
    await server.close()
  }
})

test("stdin EOF without StdinOnce closes the attachment but leaves container input reusable", async () => {
  const server = await createServer()
  seed(server, { OpenStdin: true })
  const client = await attachClient(server, id, "stdin=1&stdout=1")
  try {
    const [session] = server.attachments()
    if (!session) throw new Error("missing attachment")
    client.socket.end()
    await client.ended
    expect(session.closed).toBe(true)
    expect(server.runtime.instance().state.find(id).stdinClosed).not.toBe(true)
    expect(server.runtime.instance().state.find(id).status).toBe("running")
  } finally {
    client.close()
    await server.close()
  }
})

test("unselected output and disabled stdin are ignored", async () => {
  const server = await createServer()
  seed(server, { OpenStdin: false })
  const client = await attachClient(server, id, "stdin=1&stderr=1", Buffer.from("ignored"))
  try {
    const [session] = server.attachments()
    if (!session) throw new Error("missing attachment")
    expect(session.takeStdin().length).toBe(0)
    await session.write("stdout", Buffer.from("hidden"))
    await session.write("stderr", Buffer.from("visible"))
    expect(await client.read()).toEqual({ channel: 2, data: Buffer.from("visible") })
  } finally {
    client.close()
    await server.close()
  }
})

for (const action of ["reset", "restore", "restart", "shutdown"] as const) {
  test(`${action} invalidates old stream handles before successor state can emit`, async () => {
    const server = await createServer()
    seed(server)
    const snapshot = server.runtime.snapshot()
    const client = await attachClient(server, id)
    try {
      const [session] = server.attachments()
      if (!session) throw new Error("missing attachment")
      if (action === "reset") await server.runtime.reset()
      if (action === "restore") server.runtime.restore(snapshot)
      if (action === "restart")
        await server.runtime.fetch(
          new Request("http://docker/__admin/docker/restart", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ containers: "preserve" }),
          }),
        )
      if (action === "shutdown") server.runtime.close()
      await client.ended
      await expect(session.write("stderr", Buffer.from("stale"))).rejects.toThrow()
      expect(server.attachments()).toHaveLength(0)
    } finally {
      client.close()
      await server.close()
    }
  })
}

test("slow-reader backpressure bounds the output queue and disconnect releases pending writes", async () => {
  const size = 8 * 1024 * 1024
  const server = await createServer({ attachStreams: { maxQueuedBytes: size + 8 } })
  seed(server)
  const client = await attachClient(server, id)
  try {
    const [session] = server.attachments()
    if (!session) throw new Error("missing attachment")
    client.socket.pause()
    let settled = false
    const writing = session.write("stdout", new Uint8Array(size)).then(
      () => {
        settled = true
        return null
      },
      (error) => {
        settled = true
        return error
      },
    )
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(session.queuedBytes).toBe(size + 8)
    await expect(session.write("stderr", new Uint8Array())).rejects.toThrow("queue limit")
    session.cancel()
    expect(await writing).toBeInstanceOf(Error)
    expect(session.queuedBytes).toBe(0)
    expect(server.runtime.instance().state.find(id).status).toBe("running")
  } finally {
    client.close()
    await server.close()
  }
})

test("stdin overflow cancels only that attachment", async () => {
  const server = await createServer({ attachStreams: { maxStdinBytes: 3 } })
  seed(server, { OpenStdin: true })
  const client = await attachClient(server, id, "stdin=1&stdout=1")
  try {
    client.socket.write(Buffer.from("four"))
    await client.ended
    expect(server.attachments()).toHaveLength(0)
    expect(server.runtime.instance().state.find(id).status).toBe("running")
  } finally {
    client.close()
    await server.close()
  }
})

test("built Node stream entry honors framing and half-close under Node itself", async () => {
  const child = Bun.spawn(["node", "test/node-streams.mjs"], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, err }).toEqual({ code: 0, err: "" })
  expect(out).toContain("half-close and completion passed")
})

test("branch restore invalidates only its attachments and successor output uses new handles", async () => {
  const server = await createServer()
  seed(server)
  const before = server.runtime.checkpoint()
  server.runtime.branch("alternate", { at: before.id })
  const main = await attachClient(server, id)
  const branch = await attachClient(
    server,
    id,
    "stdout=1",
    Buffer.alloc(0),
    "x-mockingbird-branch: alternate\r\n",
  )
  try {
    const old = server.attachments().find((s) => s.branch === "alternate")
    const current = server.attachments().find((s) => s.branch === "main")
    if (!old || !current) throw new Error("missing attachments")
    server.runtime.checkout(before.id, { branch: "alternate" })
    await branch.ended
    expect(current.closed).toBe(false)
    const successor = await attachClient(
      server,
      id,
      "stdout=1",
      Buffer.alloc(0),
      "x-mockingbird-branch: alternate\r\n",
    )
    try {
      const fresh = server.attachments().find((s) => s.branch === "alternate")
      if (!fresh) throw new Error("missing successor")
      expect(fresh.id).not.toBe(old.id)
      await expect(old.write("stdout", Buffer.from("stale"))).rejects.toThrow()
      await fresh.write("stdout", Buffer.from("new"))
      expect((await successor.read()).data.toString()).toBe("new")
      await current.write("stdout", Buffer.from("main"))
      expect((await main.read()).data.toString()).toBe("main")
    } finally {
      successor.close()
    }
  } finally {
    main.close()
    branch.close()
    await server.close()
  }
})

test("peer reset releases its session while modeled execution survives", async () => {
  const server = await createServer()
  seed(server)
  const client = await attachClient(server, id)
  try {
    const [session] = server.attachments()
    if (!session) throw new Error("missing attachment")
    client.socket.resetAndDestroy()
    await until(() => session.closed)
    expect(server.attachments()).toHaveLength(0)
    expect(server.runtime.instance().state.find(id).status).toBe("running")
  } finally {
    client.close()
    await server.close()
  }
})

test("StdinOnce EOF is in history and checkout reopens input with a fresh session", async () => {
  const server = await createServer()
  seed(server, { OpenStdin: true, StdinOnce: true })
  const before = server.runtime.checkpoint()
  const client = await attachClient(server, id, "stdin=1&stdout=1")
  try {
    const [session] = server.attachments()
    if (!session) throw new Error("missing attachment")
    client.socket.end()
    await until(() => session.stdinClosed)
    const after = server.runtime.timeline().head("main")
    if (!after) throw new Error("missing checkpoint")
    expect(after.id).not.toBe(before.id)
    server.runtime.checkout(before.id)
    await client.ended
    expect(server.runtime.instance().state.find(id).stdinClosed).not.toBe(true)
    server.runtime.checkout(after.id)
    expect(server.runtime.instance().state.find(id).stdinClosed).toBe(true)
  } finally {
    client.close()
    await server.close()
  }
})

test("cancel closes StdinOnce input while restore invalidation cannot mutate restored input", async () => {
  const server = await createServer()
  seed(server, { OpenStdin: true, StdinOnce: true })
  const before = server.runtime.checkpoint()
  const client = await attachClient(server, id, "stdin=1&stdout=1")
  try {
    const [session] = server.attachments()
    if (!session) throw new Error("missing attachment")
    session.cancel()
    await client.ended
    expect(server.runtime.instance().state.find(id).stdinClosed).toBe(true)
    server.runtime.checkout(before.id)
    const fresh = await attachClient(server, id, "stdin=1&stdout=1")
    try {
      server.runtime.checkout(before.id)
      await fresh.ended
      expect(server.runtime.instance().state.find(id).stdinClosed).not.toBe(true)
      expect(server.runtime.timeline().head("main")?.id).toBe(before.id)
    } finally {
      fresh.close()
    }
  } finally {
    client.close()
    await server.close()
  }
})

test("late old-session close cannot close stdin of a restarted execution", async () => {
  const server = await createServer()
  seed(server, { OpenStdin: true, StdinOnce: true })
  const client = await attachClient(server, id, "stdin=1&stdout=1")
  try {
    const api = server.runtime.instance()
    api.lifecycle.complete(id, { exitCode: 0 })
    api.lifecycle.start(id, new URL(`http://docker/containers/${id}/start`))
    await client.ended
    await until(() => server.attachments().length === 0)
    expect(api.state.find(id).stdinClosed).toBe(false)
    expect(api.state.find(id).status).toBe("running")
  } finally {
    client.close()
    await server.close()
  }
})

test("completion discards unread stdin while already queued output drains", async () => {
  const server = await createServer({ attachStreams: { frameChunkBytes: 1 } })
  seed(server, { OpenStdin: true, StdinOnce: true })
  const client = await attachClient(server, id, "stdin=1&stdout=1", Buffer.from("unread input"))
  try {
    const [session] = server.attachments()
    if (!session) throw new Error("missing attachment")
    const output = session.write("stdout", Buffer.from("queued output"))
    server.runtime.instance().lifecycle.complete(id, { exitCode: 0 })
    const unread = session.takeStdin()
    await output
    expect((await client.read()).data.toString()).toBe("queued output")
    await client.ended
    expect(unread.byteLength).toBe(0)
  } finally {
    client.close()
    await server.close()
  }
})
