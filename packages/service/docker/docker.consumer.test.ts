import { expect, test } from "bun:test"

test("independent native Node consumers verify retained HTTP and attach over TCP and Unix", async () => {
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
  for (const transport of ["tcp", "unix"])
    expect(out).toContain(
      `${transport}: retained HTTP, accepted response loss, re-inspection and raw attach passed`,
    )
})
