import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { sealArchive } from "./src/fleet-archive.js"
import { archiveProtector } from "./src/fleet-protection.js"

const archive = () =>
  sealArchive({
    format: "mockingbird.fleet/v1",
    createdAt: new Date(0).toISOString(),
    sourceId: "synthetic",
    namespaces: {
      default: {
        clock: { now: 0, frozen: true },
        services: {
          fixture: {
            protocol: "http",
            version: 1,
            state: {
              records: [{ collection: "things", id: "1", value: "synthetic-private-payload" }],
            },
          },
        },
      },
    },
  })

test("JWE conceals state and authenticates content and metadata before returning an archive (#407)", async () => {
  const key = randomBytes(32)
  const protector = archiveProtector({
    activeKeyId: "synthetic-key-1",
    trustedKeyIds: ["synthetic-key-1"],
    resolveKey: async () => key,
  })
  const source = archive(),
    protectedArchive = await protector.seal(source)
  expect(JSON.stringify(protectedArchive)).not.toContain("synthetic-private-payload")
  expect(await protector.open(protectedArchive)).toEqual(source)
  const parts = protectedArchive.jwe.split(".")
  parts[3] = (parts[3]?.startsWith("A") ? "B" : "A") + parts[3]?.slice(1)
  await expect(protector.open({ ...protectedArchive, jwe: parts.join(".") })).rejects.toThrow(
    "authentication failed",
  )
  const header = JSON.parse(Buffer.from(parts[0] as string, "base64url").toString())
  parts[0] = Buffer.from(JSON.stringify({ ...header, kid: "untrusted" })).toString("base64url")
  await expect(protector.open({ ...protectedArchive, jwe: parts.join(".") })).rejects.toThrow(
    "untrusted",
  )
})

test("rotation writes with the active key while explicitly trusted previous keys remain readable (#407)", async () => {
  const keys = new Map([
    ["previous", randomBytes(32)],
    ["active", randomBytes(32)],
  ])
  const resolveKey = async (id: string) => {
    const key = keys.get(id)
    if (!key) throw new Error("resolver-private-details")
    return key
  }
  const old = archiveProtector({ activeKeyId: "previous", trustedKeyIds: ["previous"], resolveKey })
  const saved = await old.seal(archive())
  const rotated = archiveProtector({
    activeKeyId: "active",
    trustedKeyIds: ["active", "previous"],
    resolveKey,
  })
  expect(await rotated.open(saved)).toEqual(archive())
  const fresh = await rotated.seal(archive())
  expect(
    JSON.parse(Buffer.from(fresh.jwe.split(".")[0] as string, "base64url").toString()).kid,
  ).toBe("active")
  keys.delete("previous")
  await expect(rotated.open(saved)).rejects.toThrow("key unavailable")
})

test("protected repositories store only authenticated ciphertext and reject plaintext fallback (#407)", async () => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path")
  const { filesystemRepository } = await import("./src/fleet-repository.js")
  const dir = await mkdtemp(join(tmpdir(), "protected-repo-")),
    key = randomBytes(32)
  const protector = archiveProtector({
    activeKeyId: "synthetic",
    trustedKeyIds: ["synthetic"],
    resolveKey: async () => key,
  })
  try {
    const repository = filesystemRepository(dir, undefined, protector),
      source = archive(),
      id = await repository.put(source)
    expect(await readFile(join(dir, `${id}.json`), "utf8")).not.toContain(
      "synthetic-private-payload",
    )
    expect(await filesystemRepository(dir, undefined, protector).get(id)).toEqual(source)
    await writeFile(join(dir, `${id}.json`), JSON.stringify(source))
    await expect(repository.get(id)).rejects.toThrow("expected protected")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
