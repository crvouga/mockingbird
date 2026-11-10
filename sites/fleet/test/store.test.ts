import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import EmbeddedPostgres from "embedded-postgres"
import { checkDatabase } from "../src/preflight.js"
import { memoryDatabase } from "../src/store/memory.js"
import { postgresDatabase } from "../src/store/postgres.js"
import { type Database, type Row, UniqueViolation } from "../src/store/schema.js"

const fleet = (id: string, slug: string, extra: Partial<Row<"fleets">> = {}): Row<"fleets"> => ({
  id,
  org_id: "org_1",
  project_id: "prj_1",
  slug,
  name: "Fleet",
  access: "open",
  emulators: {
    stripe: { target: "stripe", durability: "strict", settings: { nested: [1, "two"] } },
  },
  options: {},
  revision: "r1",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...extra,
})

/** Both databases must behave identically: the domain logic is written once against the port. */
function contract(name: string, open: () => Promise<Database>) {
  describe(name, () => {
    let db: Database
    beforeAll(async () => {
      db = await open()
      await db.migrate()
    })
    afterAll(() => db.close())

    test("migrating again, even concurrently, changes nothing", async () => {
      await Promise.all([db.migrate(), db.migrate(), db.migrate()])
      await db.ping()
    })

    test("rows round-trip, including JSON and timestamps", async () => {
      await db.insert("fleets", fleet("flt_a", "alpha"))
      expect(await db.get("fleets", "flt_a")).toEqual(fleet("flt_a", "alpha"))
      expect(await db.get("fleets", "missing")).toBeUndefined()
      await db.insert("users", {
        id: "usr_1",
        issuer: "i",
        subject: "s",
        email: null,
        name: null,
        created_at: "2026-01-01T00:00:00.000Z",
      })
      expect((await db.get("users", "usr_1"))?.email).toBeNull()
    })

    test("find filters by every given column, oldest first", async () => {
      await db.insert(
        "fleets",
        fleet("flt_c", "gamma", { project_id: "prj_2", created_at: "2026-01-03T00:00:00.000Z" }),
      )
      await db.insert(
        "fleets",
        fleet("flt_b", "beta", { project_id: "prj_2", created_at: "2026-01-02T00:00:00.000Z" }),
      )
      expect((await db.find("fleets", { project_id: "prj_2" })).map((row) => row.id)).toEqual([
        "flt_b",
        "flt_c",
      ])
      expect(await db.find("fleets", { project_id: "prj_2", slug: "gamma" })).toHaveLength(1)
      expect(await db.find("fleets", { slug: "nope" })).toEqual([])
    })

    test("unique constraints report which columns collided", async () => {
      const failure = await db.insert("fleets", fleet("flt_dup", "alpha")).catch((error) => error)
      expect(failure).toBeInstanceOf(UniqueViolation)
      expect((failure as UniqueViolation).constraint).toBe("slug")
      const sameId = await db.insert("fleets", fleet("flt_a", "unused")).catch((error) => error)
      expect((sameId as UniqueViolation).constraint).toBe("id")
      const renamed = await db.update("fleets", "flt_b", { slug: "alpha" }).catch((error) => error)
      expect(renamed).toBeInstanceOf(UniqueViolation)
      await db.insert("memberships", {
        id: "mem_1",
        org_id: "o",
        user_id: "u",
        role: "owner",
        created_at: "2026-01-01T00:00:00.000Z",
      })
      const again = await db
        .insert("memberships", {
          id: "mem_2",
          org_id: "o",
          user_id: "u",
          role: "viewer",
          created_at: "2026-01-01T00:00:00.000Z",
        })
        .catch((error) => error)
      expect((again as UniqueViolation).constraint).toBe("org_id+user_id")
    })

    test("update applies only while the guard still matches", async () => {
      const first = await db.update(
        "fleets",
        "flt_a",
        { name: "One", revision: "r2" },
        { revision: "r1" },
      )
      expect(first?.name).toBe("One")
      // A second writer that read revision r1 loses.
      expect(
        await db.update("fleets", "flt_a", { name: "Two", revision: "r3" }, { revision: "r1" }),
      ).toBeUndefined()
      expect((await db.get("fleets", "flt_a"))?.name).toBe("One")
      expect(await db.update("fleets", "missing", { name: "x" })).toBeUndefined()
    })

    test("remove needs a condition and reports how many rows went", async () => {
      expect(await db.remove("fleets", { project_id: "prj_2" })).toBe(2)
      expect(await db.remove("fleets", { project_id: "prj_2" })).toBe(0)
      await expect(db.remove("fleets", {})).rejects.toThrow(/every row/)
      expect(await db.find("fleets", {})).toHaveLength(1)
    })

    test("removeExpired deletes only rows before the cutoff", async () => {
      const row = (id: string, expires_at: string) => ({
        id,
        nonce: "n",
        verifier: "v",
        return_to: "/",
        expires_at,
      })
      await db.insert("auth_transactions", row("old", "2026-01-01T00:00:00.000Z"))
      await db.insert("auth_transactions", row("new", "2026-03-01T00:00:00.000Z"))
      expect(
        await db.removeExpired("auth_transactions", "expires_at", "2026-02-01T00:00:00.000Z"),
      ).toBe(1)
      expect((await db.find("auth_transactions", {})).map((r) => r.id)).toEqual(["new"])
    })
  })
}

contract("memory database", async () => memoryDatabase())

// A real PostgreSQL server, so the SQL this service ships is the SQL that is tested.
let server: EmbeddedPostgres | undefined
let directory: string | undefined
const port = 20000 + Math.floor(Math.random() * 20000)
contract("postgres database", async () => {
  directory = await mkdtemp(join(import.meta.dir, "../.tmp-pg-"))
  server = new EmbeddedPostgres({
    databaseDir: directory,
    user: "postgres",
    password: "password",
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  })
  await server.initialise()
  await server.start()
  await server.createDatabase("fleet")
  return postgresDatabase(
    `postgres://postgres:password@127.0.0.1:${port}/fleet`,
    "mockingbird_fleet",
  )
})
afterAll(async () => {
  await server?.stop()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("preflight tells a wrong password, a missing database and a TLS mismatch apart", async () => {
  const diagnose = async (url: string) => {
    const db = postgresDatabase(url, "mockingbird_fleet")
    const problem = await checkDatabase(db, { databaseSchema: "mockingbird_fleet" })
    await db.close().catch(() => {})
    return problem
  }
  const base = `127.0.0.1:${port}`
  const password = await diagnose(`postgres://postgres:wrong-secret@${base}/fleet`)
  expect(password?.what).toBe("PostgreSQL rejected the username or password in DATABASE_URL")
  // The report quotes the driver, never the URL: the password must not leak into logs.
  expect(JSON.stringify(password)).not.toContain("wrong-secret")
  expect((await diagnose(`postgres://postgres:password@${base}/missing`))?.what).toBe(
    "The database named in DATABASE_URL does not exist",
  )
  expect((await diagnose(`postgres://postgres:password@${base}/fleet?sslmode=require`))?.what).toBe(
    "The TLS handshake with PostgreSQL failed",
  )
  expect(await diagnose(`postgres://postgres:password@${base}/fleet`)).toBeUndefined()
})
