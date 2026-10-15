import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

test("Node README uses supported distribution and matches streaming/error behavior (#427)", async () => {
  const readme = await readFile(new URL("./README.md", import.meta.url), "utf8")
  expect(readme).not.toContain("npm install @crvouga/mockingbird-adapter-node")
  expect(readme).not.toContain("(no streaming)")
  expect(readme).toContain("@crvouga/mockingbird-service-stripe/fleet")
  for (const documented of [
    "MOCKINGBIRD_DROP",
    "Set-Cookie",
    "maxBodyBytes",
    "requestTimeoutMs",
    "Contributor-only",
  ])
    expect(readme).toContain(documented)
  const pkg = JSON.parse(
    await readFile(new URL("../../service/stripe/package.json", import.meta.url), "utf8"),
  )
  expect(pkg.exports["./fleet"]).toEqual({ types: "./dist/fleet.d.ts", default: "./dist/fleet.js" })
})
