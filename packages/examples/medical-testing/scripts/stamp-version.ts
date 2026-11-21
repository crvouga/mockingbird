/**
 * Stamps `preview-dist/version.json` with the commit a deploy ships, just before it deploys. The
 * build itself may be a cache replay of an older commit's identical output, so the version is
 * stamped here rather than built in. Open tabs compare it with the version they run and update.
 *
 *   PREVIEW_VERSION  the commit SHA (default: `git rev-parse HEAD`)
 *   PREVIEW_PR, PREVIEW_PR_URL  the pull request, shown on the System screen
 */
import { resolve } from "node:path"

const outdir = resolve(import.meta.dir, "..", "preview-dist")
const { entry } = (await Bun.file(resolve(outdir, "build.json")).json()) as { entry: string }
const version =
  process.env.PREVIEW_VERSION ||
  Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim() ||
  "development"
const number = Number(process.env.PREVIEW_PR)
const stamp = {
  version,
  builtAt: new Date().toISOString(),
  entry,
  ...(number > 0 && process.env.PREVIEW_PR_URL
    ? { pr: { number, url: process.env.PREVIEW_PR_URL } }
    : {}),
}
await Bun.write(resolve(outdir, "version.json"), `${JSON.stringify(stamp)}\n`)
console.log(`version.json: ${version.slice(0, 7)} → ${entry}`)
