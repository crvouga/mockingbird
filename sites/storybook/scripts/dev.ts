/**
 * The whole catalog live: this Storybook with the Fleet Cloud and notifications Storybooks it
 * composes, each reloading as its source changes. Ctrl-C stops all three.
 *
 * The usual ports are 6008 (this one), 6006 (Fleet Cloud) and 6007 (notifications). A port that is
 * taken, by another worktree's catalog for one, is replaced by a free one, so two checkouts never
 * collide; the address printed at the end is the one to open.
 */
import { createServer } from "node:net"
import { join } from "node:path"

const root = join(import.meta.dir, "..")

/** `preferred` when nothing listens on it, else a port the system picks. */
const freePort = (preferred: number) =>
  new Promise<number>((done, fail) => {
    const probe = createServer()
    const report = () => {
      const address = probe.address()
      probe.close(() =>
        typeof address === "object" && address ? done(address.port) : fail(new Error("no port")),
      )
    }
    probe.once("error", () => {
      probe.once("error", fail)
      probe.listen(0, report)
    })
    probe.listen(preferred, report)
  })

const fleet = await freePort(6006)
const notifications = await freePort(6007)
const catalog = await freePort(6008)
const storybook = (cwd: string, port: number, env: Record<string, string> = {}) =>
  Bun.spawn(["bunx", "storybook", "dev", "-p", String(port), "--exact-port", "--no-open"], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  })
const children = [
  storybook(join(root, "../fleet"), fleet),
  storybook(join(root, "../../packages/notifications"), notifications),
  // Where the composed Storybooks are, for `.storybook/main.ts`.
  storybook(root, catalog, {
    STORYBOOK_FLEET_URL: `http://localhost:${fleet}`,
    STORYBOOK_NOTIFICATIONS_URL: `http://localhost:${notifications}`,
  }),
]
console.log(`UI catalog: http://localhost:${catalog}`)
const stop = () => {
  for (const child of children) child.kill()
  process.exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
await Promise.race(children.map((child) => child.exited))
stop()
