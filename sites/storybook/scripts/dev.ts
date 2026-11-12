/**
 * The whole catalog live: this Storybook on 6008 with the Fleet Cloud (6006) and notifications
 * (6007) Storybooks it composes, each reloading as its source changes. Ctrl-C stops all three.
 */
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const children = [
  Bun.spawn(["bun", "run", "storybook"], {
    cwd: join(root, "../fleet"),
    stdio: ["ignore", "inherit", "inherit"],
  }),
  Bun.spawn(["bun", "run", "storybook"], {
    cwd: join(root, "../../packages/notifications"),
    stdio: ["ignore", "inherit", "inherit"],
  }),
  Bun.spawn(["bun", "run", "storybook"], { cwd: root, stdio: ["ignore", "inherit", "inherit"] }),
]
console.log("UI catalog: http://localhost:6008")
const stop = () => {
  for (const child of children) child.kill()
  process.exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
await Promise.race(children.map((child) => child.exited))
stop()
