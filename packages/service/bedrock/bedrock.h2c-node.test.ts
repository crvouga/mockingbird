import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("./test/h2c-node-fixture.mjs", import.meta.url))
const node = spawnSync("node", ["--version"], { encoding: "utf8" })
const hasNode = node.status === 0

// Bun's `Readable.toWeb` ends an HTTP/2 stream body; Node's does not (issue #485), so this
// has to run the listener under real Node to see the bug.
describe.skipIf(!hasNode)("h2c listener under Node (not Bun)", () => {
  test("POST bodies over h2c and HTTP/1.1 reach the handler and end", () => {
    const run = spawnSync("node", ["--experimental-strip-types", "--no-warnings", fixture], {
      encoding: "utf8",
      timeout: 20_000,
    })
    expect(run.stderr).toBe("")
    expect(run.status).toBe(0)
    const result = JSON.parse(run.stdout) as Record<string, { method: string; length: number }>
    expect(result.h2Small).toMatchObject({ method: "POST", length: '{"messages":[]}'.length })
    expect(result.h2Chunked).toMatchObject({ method: "POST", length: 8 * 64 * 1024 })
    expect(result.h1).toMatchObject({ method: "POST", length: '{"messages":[]}'.length })
  }, 30_000)
})
