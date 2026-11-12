/**
 * Every story must draw cleanly: no render error, no failed `play` assertion, nothing logged as
 * an error. Builds the catalog first unless `--no-build`; `--only <prefix>` limits it to the
 * stories whose id starts with the prefix (e.g. `emulators-stripe`).
 *
 *   bun run verify                                  # build, then check every story
 *   bun run verify --no-build --only emulators-stripe
 *   bun run verify --no-build --base http://localhost:8080/storybook   # as the docs site serves it
 */
import { entries, hasDocs, launch, pool, render, serve } from "./stories.js"

const args = process.argv.slice(2)
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined
const dir = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : undefined
const live = args.includes("--base")
  ? args[args.indexOf("--base") + 1]?.replace(/\/$/, "")
  : undefined

if (!args.includes("--no-build") && !live) {
  const build = Bun.spawnSync(["bun", "run", "storybook:build"], {
    cwd: `${import.meta.dir}/..`,
    stdio: ["ignore", "inherit", "inherit"],
  })
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)
}

const server = live ? undefined : serve(dir)
const base = live ?? server?.base ?? ""
// The "Docs site" stories frame the built docs site; without one (`turbo run build` builds it
// after this catalog) there is nothing for them to show.
const skipDocs = !live && !hasDocs()
const stories = (await entries(base)).filter(
  (entry) =>
    (!only || entry.id.startsWith(only)) && !(skipDocs && entry.id.startsWith("docs-site")),
)
if (skipDocs) console.log("sites/docs is not built: skipping the Docs site stories")
const browser = await launch()
const results = await pool(browser, stories, (page, story) => render(page, base, story))
await browser.close()
server?.stop()

const failed = results.filter((result) => !result.ok)
for (const result of failed) console.error(`✗ ${result.id}\n    ${result.problems.join("\n    ")}`)
console.log(`${results.length - failed.length}/${results.length} stories drew cleanly`)
process.exit(failed.length ? 1 : 0)
