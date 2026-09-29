import { expect, test } from "bun:test"

test("oracle safety and independent frame decoding under native Node", async () => {
  const child = Bun.spawn(["node", "--test", "--test-reporter=tap", "test/oracle-safety.mjs"], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, err, failed: out.includes("not ok") }).toEqual({ code: 0, err: "", failed: false })
  expect(out).toContain("# pass 14")
})
