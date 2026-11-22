/**
 * Test helper: an npm registry whose packuments come from a fake `npm` script on disk, so a
 * release test scripts registry state the same way for `npm view` reads and registry fetches.
 * Each GET runs `<npm> view <name> versions --json --prefer-online`, which also logs the call.
 */
export function fakeRegistry(npm: string, env: Record<string, string | undefined>) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const name = decodeURIComponent(new URL(request.url).pathname.slice(1))
      const proc = Bun.spawn([npm, "view", name, "versions", "--json", "--prefer-online"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      if (code !== 0) {
        return new Response(err, { status: /E404|404 Not Found/.test(out + err) ? 404 : 500 })
      }
      const parsed = (out.trim() ? JSON.parse(out) : []) as string | string[]
      const versions = [parsed].flat()
      return Response.json({
        name,
        versions: Object.fromEntries(versions.map((v) => [v, { name, version: v }])),
        time: Object.fromEntries(versions.map((v) => [v, "2026-01-01T00:00:00.000Z"])),
      })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}
