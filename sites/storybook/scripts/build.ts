/**
 * The published catalog: this Storybook in `storybook-static/`, with the Fleet Cloud and
 * notifications Storybooks (built by their own `storybook:build`, which turbo runs first) copied
 * into `fleet/` and `notifications/`, where `.storybook/main.ts` points its refs.
 */
import { cpSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const out = join(root, "storybook-static")
const REFS = {
  fleet: join(root, "../fleet/storybook-static"),
  notifications: join(root, "../../packages/notifications/storybook-static"),
}

const build = Bun.spawnSync(["bun", "run", "storybook:build"], {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
})
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)

for (const [name, dir] of Object.entries(REFS)) {
  if (!existsSync(join(dir, "index.json"))) {
    console.error(
      `${dir} is missing: run its storybook:build first (turbo does: turbo run build --filter=@crvouga/mockingbird-storybook)`,
    )
    process.exit(1)
  }
  rmSync(join(out, name), { recursive: true, force: true })
  cpSync(dir, join(out, name), { recursive: true })
}
console.log(`catalog in ${out}, with ${Object.keys(REFS).join(" and ")} composed in`)
