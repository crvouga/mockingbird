/**
 * Build the dashboard (and the server bundle) once before any scenario: the server under test
 * serves the dashboard's files from `dist/public`. Set SPEC_SKIP_BUILD=1 to reuse an existing
 * build, e.g. when several runs share one checkout.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { PACKAGE_ROOT } from "./stack.js"

export default function globalSetup() {
  if (process.env.SPEC_SKIP_BUILD === "1" && existsSync(join(PACKAGE_ROOT, "dist/public/app.js")))
    return
  const build = spawnSync("bun", ["scripts/build.ts"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (build.status !== 0)
    throw new Error(`Building the dashboard failed:\n${build.stdout}\n${build.stderr}`)
  // Dashboard scenarios drive a real browser. Installing is a no-op when it is already there,
  // which keeps `bun run spec` a single command on a fresh machine and in CI.
  const browser = spawnSync("bunx", ["playwright", "install", "chromium"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (browser.status !== 0)
    throw new Error(`Installing Chromium failed:\n${browser.stdout}\n${browser.stderr}`)
}
