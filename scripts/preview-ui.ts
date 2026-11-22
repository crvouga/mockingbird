/**
 * Run the Mockingbird-owned UI (System, Lab, Emulators, Notifications) from this checkout and make
 * it reachable from another device, such as a phone.
 *
 * Serves the lab's system preview from the dev server (`devPreview`): built in memory, rebuilt
 * when a source file is saved, and swapped into every open tab in place, with no reload. It
 * listens on every interface and, when Tailscale is running, is also published over HTTPS inside
 * the tailnet. The HTTPS address matters on a phone: the lab signs in with `crypto.subtle`, which
 * browsers only expose on HTTPS or localhost.
 *
 *   bun scripts/preview-ui.ts            # build the packages it uses, then serve and watch
 *   bun scripts/preview-ui.ts --no-build # skip the package build (they are built already)
 *   bun scripts/preview-ui.ts --packages # also rebuild workspace packages when their source changes
 *   bun scripts/preview-ui.ts --static   # the minified build a deploy ships, served as files
 *
 * The lab's own source (`packages/examples/medical-testing/src`) is watched directly. A workspace
 * package is read from its `dist`, so a change to one reaches the tab when that package is built
 * again: by hand, or by `--packages`, which keeps `turbo watch` running beside the server.
 *
 * Ports never collide. Each checkout gets its own pair, derived from its path, so several
 * worktrees serve side by side and a checkout's addresses stay the same from run to run; a port
 * something else holds is stepped over. Starting it again in the same checkout replaces the
 * earlier run. `--port=` and `--https-port=` ask for particular ports first.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { networkInterfaces } from "node:os"
import { join, normalize, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const dist = join(root, "packages/examples/medical-testing/preview-dist")
const flag = (name: string, fallback: number) =>
  Number(
    process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback,
  )

const tailscale = (...args: string[]) => {
  try {
    return Bun.spawnSync(["tailscale", ...args], { stdio: ["ignore", "pipe", "pipe"] })
  } catch {
    return undefined
  }
}

// ---- One run per checkout: a newer run stops the earlier one and takes over its addresses.

const stateFile = join(root, ".worktree/preview-ui.json")
type State = { pid: number; port: number; httpsPort?: number }
const earlier = (() => {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")) as State
  } catch {
    return undefined
  }
})()
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
if (earlier && alive(earlier.pid)) {
  process.kill(earlier.pid, "SIGTERM")
  for (let waited = 0; alive(earlier.pid) && waited < 5000; waited += 100) await Bun.sleep(100)
}
// An earlier run that died without cleaning up leaves its tailnet address behind.
if (earlier?.httpsPort) tailscale("serve", `--https=${earlier.httpsPort}`, "off")

// ---- Ports: this checkout's own, stepping over any that are taken.

/** A stable number from the checkout's path, so each worktree asks for different ports. */
const slot = [...root].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7) % 2000
const listens = (candidate: number) =>
  new Promise<boolean>((done) => {
    const probe = createServer()
    probe.once("error", () => done(false))
    probe.listen(candidate, "0.0.0.0", () => probe.close(() => done(true)))
  })
/** The first port from `start` that `free` accepts. */
const firstFree = async (
  start: number,
  free: (candidate: number) => boolean | Promise<boolean>,
) => {
  for (let candidate = start; candidate < start + 200; candidate += 1)
    if (await free(candidate)) return candidate
  throw new Error(`No free port in ${start}-${start + 199}`)
}
const port = await firstFree(flag("port", earlier?.port ?? 20000 + slot * 5), listens)

// Declared before anything can call `stop`.
let published = false
let httpsPort: number | undefined

const example = join(root, "packages/examples/medical-testing")
const filter = "--filter=@crvouga/mockingbird-example-medical-testing"
const fixed = process.argv.includes("--static")
const turbo = (...args: string[]) =>
  Bun.spawnSync(["bunx", "turbo", ...args], { cwd: root, stdio: ["ignore", "inherit", "inherit"] })

if (!process.argv.includes("--no-build")) {
  // The dev server builds the lab itself; it only needs the packages the lab imports.
  const build = fixed
    ? turbo("run", "preview:build", filter)
    : turbo("run", "build", `${filter}^...`)
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)
}

const children: Bun.Subprocess[] = []
let stopStatic = () => {}
if (fixed) {
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
  stopStatic = () => server.stop(true)
} else {
  const spawn = (command: string[], cwd: string) => {
    const child = Bun.spawn(command, { cwd, stdio: ["ignore", "inherit", "inherit"] })
    children.push(child)
    return child
  }
  const server = spawn(
    ["bun", "scripts/dev-preview.ts", `--port=${port}`, "--host=0.0.0.0", "--strict-port"],
    example,
  )
  void server.exited.then((code) => {
    if (code !== 0) console.error(`The dev server stopped (exit ${code}).`)
    stop(code ?? 1)
  })
  if (process.argv.includes("--packages"))
    spawn(["bunx", "turbo", "watch", "build", `${filter}^...`], root)
  // Listening, with the first build done, before the addresses are printed.
  for (let waited = 0; waited < 60_000; waited += 100) {
    const up = await fetch(`http://127.0.0.1:${port}/__preview/status`).then(
      (response) => response.ok,
      () => false,
    )
    if (up) break
    await Bun.sleep(100)
  }
}

const status = tailscale("status", "--json")
const dnsName =
  status?.exitCode === 0
    ? (JSON.parse(status.stdout.toString()).Self?.DNSName as string | undefined)?.replace(/\.$/, "")
    : undefined
if (dnsName) {
  // Tailnet ports other things already serve on are theirs.
  const config = tailscale("serve", "status", "--json")
  const served = new Set(
    Object.keys(
      (config?.exitCode === 0 ? JSON.parse(config.stdout.toString() || "{}") : {}).TCP ?? {},
    ),
  )
  httpsPort = await firstFree(
    flag("https-port", earlier?.httpsPort ?? 30000 + slot * 5),
    (candidate) => !served.has(String(candidate)),
  )
  const serve = tailscale("serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${port}`)
  published = serve?.exitCode === 0
  if (!published) console.warn(`tailscale serve failed: ${serve?.stderr.toString().trim()}`)
}

mkdirSync(join(root, ".worktree"), { recursive: true })
writeFileSync(
  stateFile,
  JSON.stringify({
    pid: process.pid,
    port,
    ...(published && httpsPort !== undefined ? { httpsPort } : {}),
  } satisfies State),
)

const lan = Object.values(networkInterfaces())
  .flat()
  .filter((address) => address && address.family === "IPv4" && !address.internal)
  .map((address) => `http://${address?.address}:${port}`)

console.log(`\nMockingbird UI preview`)
console.log(`  This machine:  http://localhost:${port}`)
if (published) console.log(`  Phone (HTTPS): https://${dnsName}:${httpsPort}  (tailnet only)`)
console.log(`  Plain HTTP:    ${lan.join("  ")}`)
if (!published) console.log("  Sign-in needs HTTPS or localhost; over plain HTTP it will fail.")
console.log(`  Screens: ?surface=system | app | emulators | notifications`)
console.log(
  fixed
    ? "  Serving the built files: run it again to see a change.\n"
    : "  Watching: save a file and open tabs update in place.\n",
)

function stop(code = 0) {
  if (published) tailscale("serve", `--https=${httpsPort}`, "off")
  try {
    if ((JSON.parse(readFileSync(stateFile, "utf8")) as State).pid === process.pid)
      rmSync(stateFile)
  } catch {
    /* Already gone, or a newer run's. */
  }
  for (const child of children) child.kill()
  stopStatic()
  process.exit(code)
}
process.on("SIGINT", () => stop())
process.on("SIGTERM", () => stop())
