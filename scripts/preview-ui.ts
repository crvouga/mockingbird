/**
 * Run the Mockingbird-owned UI (System, Lab, Emulators, Notifications) from this checkout and make
 * it reachable from another device, such as a phone.
 *
 * Builds the lab's static system preview, serves it on every interface, and, when Tailscale is
 * running, also publishes it over HTTPS inside the tailnet. The HTTPS address matters on a phone:
 * the lab signs in with `crypto.subtle`, which browsers only expose on HTTPS or localhost.
 *
 *   bun scripts/preview-ui.ts            # build, then serve
 *   bun scripts/preview-ui.ts --no-build # serve the last build
 *
 * `--port=4810` and `--https-port=8443` change the ports.
 */
import { existsSync } from "node:fs"
import { networkInterfaces } from "node:os"
import { join, normalize, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const dist = join(root, "packages/examples/medical-testing/preview-dist")
const flag = (name: string, fallback: number) =>
  Number(
    process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback,
  )
const port = flag("port", 4810)
const httpsPort = flag("https-port", 8443)

if (!process.argv.includes("--no-build")) {
  const build = Bun.spawnSync(
    [
      "bunx",
      "turbo",
      "run",
      "preview:build",
      "--filter=@crvouga/mockingbird-example-medical-testing",
    ],
    { cwd: root, stdio: ["ignore", "inherit", "inherit"] },
  )
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)
}
if (!existsSync(join(dist, "index.html"))) {
  console.error(`No preview build at ${dist}. Run without --no-build.`)
  process.exit(1)
}

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname)
    const path = normalize(join(dist, pathname))
    const file = Bun.file(path.startsWith(dist) && !pathname.endsWith("/") ? path : "")
    const found = file.size > 0 && (await file.exists())
    return new Response(found ? file : Bun.file(join(dist, "index.html")), {
      headers: { "cache-control": "no-store" },
    })
  },
})

const tailscale = (...args: string[]) => {
  try {
    return Bun.spawnSync(["tailscale", ...args], { stdio: ["ignore", "pipe", "pipe"] })
  } catch {
    return undefined
  }
}

let published = false
const status = tailscale("status", "--json")
const dnsName =
  status?.exitCode === 0
    ? (JSON.parse(status.stdout.toString()).Self?.DNSName as string | undefined)?.replace(/\.$/, "")
    : undefined
if (dnsName) {
  const serve = tailscale("serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${port}`)
  published = serve?.exitCode === 0
  if (!published) console.warn(`tailscale serve failed: ${serve?.stderr.toString().trim()}`)
}

const lan = Object.values(networkInterfaces())
  .flat()
  .filter((address) => address && address.family === "IPv4" && !address.internal)
  .map((address) => `http://${address?.address}:${port}`)

console.log(`\nMockingbird UI preview`)
console.log(`  This machine:  http://localhost:${port}`)
if (published) console.log(`  Phone (HTTPS): https://${dnsName}:${httpsPort}  (tailnet only)`)
console.log(`  Plain HTTP:    ${lan.join("  ")}`)
if (!published) console.log("  Sign-in needs HTTPS or localhost; over plain HTTP it will fail.")
console.log(`  Screens: ?surface=system | app | emulators | notifications\n`)

const stop = () => {
  if (published) tailscale("serve", `--https=${httpsPort}`, "off")
  server.stop(true)
  process.exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
