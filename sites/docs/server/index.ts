/**
 * The docs server: Astro's standalone handler behind the security headers. Astro serves its
 * prerendered pages before any Astro middleware runs, so the headers go on here.
 *   bun ./server/index.ts   (after `astro build`; HOST and PORT as for the standalone server)
 */
import { readFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { pagePolicies, type StaticHeaders, setSecurityHeaders } from "./headers.ts"

type Entry = {
  handler: (req: IncomingMessage, res: ServerResponse) => void
  options: { host?: string | boolean; port?: number }
}

process.env.ASTRO_NODE_AUTOSTART = "disabled"
const dist = new URL("../dist/", import.meta.url)
const { handler, options } = (await import(new URL("server/entry.mjs", dist).href)) as Entry
const policies = pagePolicies(
  JSON.parse(readFileSync(new URL("_headers.json", dist), "utf8")) as StaticHeaders,
)

const port = Number(process.env.PORT ?? options.port ?? 8080)
const host =
  process.env.HOST ??
  (typeof options.host === "string" ? options.host : options.host ? "0.0.0.0" : "localhost")

const server = createServer((req, res) => {
  setSecurityHeaders(req.url ?? "/", res, policies)
  handler(req, res)
})
server.listen(port, host, () => console.log(`docs listening on http://${host}:${port}`))
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
