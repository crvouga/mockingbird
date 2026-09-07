/**
 * Test-file naming gate.
 *
 * Mockingbird bans example-based tests. Every suite must be a property-based
 * test and named `<name>.property.test.ts`. This gate fails on any `*.test.ts`
 * that does not match that convention (and on anywhere the no-fixtures rule
 * could be silently bypassed).
 *
 *   bun run check:tests
 */
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const errors: string[] = []

function fail(message: string): void {
  errors.push(message)
  console.error(`::error::${message}`)
}

const files: string[] = []
const glob = new Bun.Glob("packages/**/*.test.ts")
for (const entry of glob.scanSync({ cwd: root })) {
  if (
    entry.includes("node_modules") ||
    entry.includes("/dist/") ||
    entry.includes("/src/generated/")
  )
    continue
  files.push(entry)
}

console.log(`check:tests: ${files.length} test files`)
for (const rel of files) {
  if (!rel.endsWith(".property.test.ts")) {
    fail(
      `${rel} must be named *.property.test.ts — example-based tests are banned; write a property-based suite.`,
    )
  }
}

if (errors.length > 0) {
  console.error("")
  console.error(`check:tests FAILED (${errors.length}) — fix the issues above.`)
  process.exit(1)
}

console.log(`check:tests: OK (${files.length} files conform)`)
