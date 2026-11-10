/**
 * Writes `openapi.json`, the published contract, from the route table. `--check` fails when the
 * committed file is stale, so a route change cannot ship without its contract.
 */
import { join } from "node:path"
import { createRoutes } from "../src/api.js"
import { openApiDocument } from "../src/openapi.js"

const path = join(import.meta.dir, "../openapi.json")
const text = `${JSON.stringify(openApiDocument(createRoutes(), "https://mockingbird-fleet.chrisvouga.dev"), null, 2)}\n`
const file = Bun.file(path)
if (process.argv.includes("--check")) {
  if (!(await file.exists()) || (await file.text()) !== text) {
    console.error("stale: sites/fleet/openapi.json (run `bun run openapi` in sites/fleet)")
    process.exit(1)
  }
} else await Bun.write(path, text)
