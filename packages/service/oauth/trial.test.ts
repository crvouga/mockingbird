import { expect, test } from "bun:test"
test("dist", async () => {
  const { __trial } = (await import("./dist/index.js")) as unknown as { __trial: (n: string) => Promise<string> }
  const html = await __trial("Acme")
  expect(html).toContain("Allow Acme?")
  expect(html).toContain("MockingbirdTrial.start(")
  console.log(html.length)
})
test("src", async () => {
  const { __trial } = (await import("./src/index.ts")) as unknown as { __trial: (n: string) => Promise<string> }
  const html = await __trial("Src")
  expect(html).toContain("Allow Src?")
})
