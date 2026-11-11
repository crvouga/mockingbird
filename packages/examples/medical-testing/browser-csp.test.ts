import { expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The docs site serves this example under a Content Security Policy whose `script-src` has no
 * `'unsafe-eval'`. Anything that evaluates a string (`eval`, `new Function`, a string timer)
 * throws there, which is how the Emulators tab once showed a CSP error instead of the admin UI.
 * `sites/docs/e2e/example-csp.e2e.ts` proves it in a browser; this is the cheap half
 * that runs everywhere.
 */
const EVALUATES_A_STRING = /\bnew\s+Function\b|(?<![\w.$])Function\s*\(|(?<![\w.$])eval\s*\(/

const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : []
  })

test("no source file in the browser path evaluates a string", () => {
  for (const directory of ["src/client", "src/composition"]) {
    for (const path of sources(join(import.meta.dir, directory))) {
      const code = readFileSync(path, "utf8")
      expect({ path, evaluates: EVALUATES_A_STRING.test(code) }).toEqual({ path, evaluates: false })
    }
  }
})

const bundle = join(import.meta.dir, "dist/browser.js")

// `test` depends on `build`. The bundle inlines the shared admin UI (React and Ant Design), the
// notifications UI and this app, so this covers the code they run, not only what is written here.
test.skipIf(!existsSync(bundle))("the built browser bundle never evaluates a string", () => {
  const code = readFileSync(bundle, "utf8")
  expect(code.match(new RegExp(EVALUATES_A_STRING.source, "g")) ?? []).toEqual([])
  // The admin UI is mounted as code. The prebuilt copy an emulator's own page inlines as a
  // string (the `MockingbirdAdmin` global) is not shipped a second time.
  expect(code).not.toContain("MockingbirdAdmin")
})
