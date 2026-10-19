// Runs under plain Node (not Bun): POSTs bodies to `listenH2c` over h2c and HTTP/1.1 and
// prints what the Fetch handler read. `Readable.toWeb(http2Stream)` never ends on Node 22.
import { request as http1Request } from "node:http"
import { connect } from "node:http2"
import { listenH2c } from "../src/h2c.ts"

const api = {
  fetch: async (req) => {
    const body = await req.text()
    return new Response(
      JSON.stringify({ method: req.method, length: body.length, body: body.slice(0, 20) }),
      {
        headers: { "content-type": "application/json" },
      },
    )
  },
}

const withTimeout = (promise, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: no response in 5s`)), 5000),
    ),
  ])

const [chunkCount, chunkSize] = [8, 64 * 1024]
const chunks = Array.from({ length: chunkCount }, (_, i) =>
  String(i).repeat(chunkSize).slice(0, chunkSize),
)

const h2Post = (session, chunked) =>
  new Promise((resolve, reject) => {
    const req = session.request({
      ":method": "POST",
      ":path": "/model/m/converse",
      "content-type": "application/json",
    })
    let out = ""
    req.setEncoding("utf8")
    req.on("data", (chunk) => (out += chunk))
    req.on("end", () => resolve(JSON.parse(out)))
    req.on("error", reject)
    if (chunked) {
      for (const chunk of chunks) req.write(chunk)
      req.end()
    } else {
      req.end('{"messages":[]}')
    }
  })

const h1Post = (port) =>
  new Promise((resolve, reject) => {
    const req = http1Request({ host: "127.0.0.1", port, method: "POST", path: "/x" }, (res) => {
      let out = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => (out += chunk))
      res.on("end", () => resolve(JSON.parse(out)))
    })
    req.on("error", reject)
    req.end('{"messages":[]}')
  })

const server = await listenH2c(api)
const session = connect(server.url)
try {
  const result = {
    h2Small: await withTimeout(h2Post(session, false), "h2 small"),
    h2Chunked: await withTimeout(h2Post(session, true), "h2 chunked"),
    h1: await withTimeout(h1Post(server.port), "h1"),
  }
  process.stdout.write(JSON.stringify(result))
  session.close()
  await server.close()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
