import { expect, test } from "bun:test"

test("independent Node HTTP consumer verifies peer recovery and expiry", async () => {
  const child = Bun.spawn(["node", "test/node-consumer.mjs"], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, err }).toEqual({ code: 0, err: "" })
  expect(out).toContain("native HTTP: response loss, replay, poll, stop, timeout and expiry passed")
})
