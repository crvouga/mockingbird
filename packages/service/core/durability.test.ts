import { expect, test } from "bun:test"
import { MemoryDurabilityBackend, openDurableDatabase } from "@crvouga/mockingbird-service-sqlite"
import { migrateCore } from "@crvouga/mockingbird-sqlite"
import { Collection } from "./src/collection.js"
import { restoreNamespace, snapshotNamespace } from "./src/snapshot.js"

test("shared collection storage can persist every service through its existing SQLite port", async () => {
  const backend = new MemoryDurabilityBackend()
  const handle = await openDurableDatabase({ key: "services", backend })
  const db = handle.value
  migrateCore(db)
  const first = new Collection<{ name: string }>(db, "first", "things")
  const second = new Collection<{ name: string }>(db, "second", "things")
  first.insert("same-id", { name: "before" })
  second.insert("same-id", { name: "other namespace" })
  const snapshot = snapshotNamespace(db, "first")
  first.update("same-id", { name: "after" })
  await handle.flush()
  restoreNamespace(db, "first", snapshot)
  // Reused statements must see restores, resets, transaction rollback and new rows.
  expect(first.get("same-id")).toEqual({ name: "before" })
  expect(() =>
    db.transaction(() => {
      first.delete("same-id")
      throw new Error("rollback")
    }),
  ).toThrow("rollback")
  expect(first.has("same-id")).toBe(true)
  await handle.close()
  const reopened = await openDurableDatabase({ key: "services", backend })
  migrateCore(reopened.value)
  const recovered = new Collection<{ name: string }>(reopened.value, "first", "things")
  expect(recovered.get("same-id")).toEqual({ name: "before" })
  expect(recovered.insert("new", { name: "new" }).seq).toBe(2)
  expect(
    new Collection<{ name: string }>(reopened.value, "second", "things").get("same-id"),
  ).toEqual({ name: "other namespace" })
  await reopened.close()
})
