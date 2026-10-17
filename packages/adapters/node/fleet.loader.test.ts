import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startFleet } from "./src/fleet.js"
import { createInstalledServiceLoader } from "./src/fleet-loader.js"

test("allowlisted resolver uses the explicit consumer root and pnpm-style linked /server exports (#454)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mockingbird-loader-"))
  try {
    const store = join(dir, "store", "service"),
      scope = join(dir, "node_modules", "@crvouga")
    await mkdir(store, { recursive: true })
    await mkdir(scope, { recursive: true })
    await writeFile(
      join(store, "package.json"),
      JSON.stringify({
        name: "@crvouga/mockingbird-service-fixture",
        type: "module",
        exports: { "./server": "./server.js" },
      }),
    )
    await writeFile(
      join(store, "server.js"),
      'export const serveTarget = {name:"fixture", protocol:"external", defaultPort:0, start(){throw new Error("synthetic target loaded")}}',
    )
    await symlink(store, join(scope, "mockingbird-service-fixture"), "dir")
    const load = createInstalledServiceLoader({ projectRoot: dir, services: ["fixture", "absent"] })
    expect((await load("fixture")).name).toBe("fixture")
    await expect(load("absent")).rejects.toThrow("install @crvouga/mockingbird-service-absent")
    for (const invalid of [
      "../fixture",
      "https://example.test/module",
      "fixture/server",
      "undeclared",
    ])
      await expect(load(invalid)).rejects.toThrow("allowlist")
    await expect(
      startFleet({ services: { separate: { target: "absent", port: 0 } } }, { load }),
    ).rejects.toThrow("install")
    expect(() =>
      createInstalledServiceLoader({ projectRoot: dir, services: ["../fixture"] }),
    ).toThrow("invalid service suffix")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
