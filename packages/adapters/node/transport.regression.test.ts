import { expect, test } from "bun:test"
import { connect } from "node:net"
import { listen } from "./src/listen.js"

test("an interrupted upload leaves the same listener healthy (#359)", async () => {
  const server = await listen({ fetch: async (r) => new Response(await r.text()) })
  try {
    const socket = connect(server.port, "127.0.0.1")
    await new Promise<void>((resolve) => socket.once("connect", resolve))
    socket.write("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{")
    await Bun.sleep(25)
    socket.destroy()
    await Bun.sleep(25)
    expect((await fetch(server.url)).status).toBe(200)
  } finally {
    await server.close()
  }
})

test("disconnect cancels a response even while waiting for drain (#381)", async () => {
  let cancelled = false
  const server = await listen({
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024))
          },
          cancel() {
            cancelled = true
          },
        }),
      ),
  })
  try {
    const socket = connect(server.port, "127.0.0.1")
    await new Promise<void>((resolve) => socket.once("connect", resolve))
    socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
    socket.pause()
    await Bun.sleep(30)
    socket.destroy()
    for (let i = 0; !cancelled && i < 100; i++) await Bun.sleep(5)
    expect(cancelled).toBe(true)
  } finally {
    await server.close()
  }
})

test("chunked uploads enforce incremental byte limits and timeouts (#376)", async () => {
  const { serve } = await import("./src/serve.js")
  const server = await serve(
    { fetch: async (r) => new Response(await r.text()) },
    { host: "127.0.0.1", maxBodyBytes: 4, requestTimeoutMs: 50 },
  )
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  const raw = async (text: string) => {
    const socket = connect(port, "127.0.0.1")
    let response = ""
    socket.on("data", (data) => {
      response += data.toString()
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject)
      socket.once("connect", () => socket.write(text))
      socket.once("close", () => resolve())
    })
    return response
  }
  try {
    expect(
      await raw(
        "POST / HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n12345\r\n",
      ),
    ).toContain("413")
    expect(await raw("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\n1")).toContain(
      "408",
    )
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200)
  } finally {
    server.close()
    server.closeAllConnections()
  }
})

test("real Node process survives aborted TCP uploads and cancels disconnected streams (#359, #381)", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = await mkdtemp(join(tmpdir(), "node-transport-"))
  await writeFile(
    join(dir, "entry.ts"),
    `import { serve } from ${JSON.stringify(join(import.meta.dir, "src/serve.ts"))};
let cancelled = 0;
const server = await serve({ fetch: async (request) => {
 const path = new URL(request.url).pathname;
 if (path === '/cancelled') return new Response(String(cancelled));
 if (path === '/stream') return new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024*1024)); }, cancel() { cancelled++; } }));
 return new Response(await request.text());
}}, {host:'127.0.0.1'});
console.log(JSON.stringify(server.address()));
process.once('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });`,
  )
  const built = await Bun.build({
    entrypoints: [join(dir, "entry.ts")],
    outdir: dir,
    naming: "entry.mjs",
    target: "node",
  })
  expect(built.success).toBe(true)
  const child = Bun.spawn(["node", join(dir, "entry.mjs")], { stdout: "pipe", stderr: "pipe" })
  try {
    const reader = child.stdout.getReader(),
      output = await reader.read()
    reader.releaseLock()
    const { port } = JSON.parse(new TextDecoder().decode(output.value)) as { port: number }
    const socket = connect(port, "127.0.0.1")
    await new Promise<void>((r) => socket.once("connect", r))
    socket.write("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{")
    await Bun.sleep(20)
    socket.destroy()
    await Bun.sleep(20)
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200)
    const stream = connect(port, "127.0.0.1")
    await new Promise<void>((r) => stream.once("connect", r))
    stream.write("GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n")
    stream.pause()
    await Bun.sleep(30)
    stream.destroy()
    let cancelled = "0"
    for (let i = 0; i < 100 && cancelled === "0"; i++) {
      await Bun.sleep(5)
      cancelled = await (await fetch(`http://127.0.0.1:${port}/cancelled`)).text()
    }
    expect(cancelled).toBe("1")
    child.kill("SIGTERM")
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stderr).text()).toBe("")
  } finally {
    child.kill()
    await child.exited
    await rm(dir, { recursive: true, force: true })
  }
})
