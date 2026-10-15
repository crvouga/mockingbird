import { expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileParticipant } from "./src/fleet-files.js"
import { startFleet } from "./src/fleet.js"
import { sealArchive } from "./src/fleet-archive.js"

const call = (fleet: Awaited<ReturnType<typeof startFleet>>, path: string, body?: unknown) => fleet.fetch(new Request(`${fleet.manifest.adminBase}${path}`, { method: body === undefined ? "GET" : "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))

test("registered file participants use the same coordinated namespace archives with fresh-root recovery (#420)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-files-"))
  const source = await fileParticipant(join(dir, "source"), ["state.json", "nested/synthetic.txt"])
  const first = await startFleet({ services: {} }, { load: async () => { throw new Error("unexpected native target") }, participants: { appstate: source } })
  let second: Awaited<ReturnType<typeof startFleet>> | undefined
  try {
    expect((await call(first, "/namespaces/alpha", {})).status).toBe(201)
    expect((await call(first, "/namespaces/beta", {})).status).toBe(201)
    await source.write("alpha", "state.json", new TextEncoder().encode('{"synthetic":7}'))
    await source.write("beta", "nested/synthetic.txt", new TextEncoder().encode("independent"))
    const fence = source.lock("alpha")
    await expect(source.write("alpha", "state.json", new Uint8Array())).rejects.toThrow("fenced"); fence()
    const archive = await (await call(first, "/archives/export", { allNamespaces: true })).json()
    await first.close()
    const destination = await fileParticipant(join(dir, "destination"), ["state.json", "nested/synthetic.txt"])
    second = await startFleet({ services: {} }, { load: async () => { throw new Error("unexpected native target") }, participants: { appstate: destination } })
    expect((await call(second, "/archives/import", { archive })).status).toBe(200)
    expect(new TextDecoder().decode(await destination.read("alpha", "state.json"))).toBe('{"synthetic":7}')
    expect(new TextDecoder().decode(await destination.read("beta", "nested/synthetic.txt"))).toBe("independent")
    const section = archive.namespaces.alpha.services.appstate.state
    section.files = { "../escape": "dW5zYWZl" }
    const { sha256: _sha, ...content } = archive
    expect((await call(second, "/archives/import", { archive: sealArchive(content) })).status).toBe(400)
    expect(new TextDecoder().decode(await destination.read("alpha", "state.json"))).toBe('{"synthetic":7}')
  } finally { await first.close(); await second?.close(); await rm(dir, { recursive: true, force: true }) }
})

test("file participants reject archive paths, namespace traversal and host symlinks (#420)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-file-root-"))
  try {
    await expect(fileParticipant(join(dir, "state"), ["../outside"])).rejects.toThrow("allowlist")
    const participant = await fileParticipant(join(dir, "state"), ["data"])
    await expect(participant.createNamespace?.("..")).rejects.toThrow("namespace")
    await writeFile(join(dir, "outside"), "synthetic-outside")
    await symlink(join(dir, "outside"), join(dir, "state", "default", "data"))
    await expect(participant.read("default", "data")).rejects.toThrow("symlink")
    await expect(participant.write("default", "data", new Uint8Array())).rejects.toThrow("symlink")
    expect(await readFile(join(dir, "outside"), "utf8")).toBe("synthetic-outside")
  } finally { await rm(dir, { recursive: true, force: true }) }
})
