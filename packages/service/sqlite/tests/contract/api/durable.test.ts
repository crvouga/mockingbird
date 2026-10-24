import { expect, test } from "bun:test";
import { LocalStorageDurabilityBackend, MemoryDurabilityBackend, openDurableDatabase } from "../../../src/index.ts";

for (const kind of ["memory", "localStorage"] as const) {
  test(`durable ${kind}: SQL, rollback, schema and prepared handles survive saving/reopening`, async () => {
    const entries = new Map<string, string>();
    const backend =
      kind === "memory"
        ? new MemoryDurabilityBackend()
        : new LocalStorageDurabilityBackend({
            storage: {
              getItem: (key) => entries.get(key) ?? null,
              setItem: (key, value) => {
                entries.set(key, value);
              },
            },
          });
    const handle = await openDurableDatabase({ key: "database", backend, pageSize: 64 });
    const db = handle.value;
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT, data BLOB)");
    const insert = db.prepare("INSERT INTO t VALUES (?, ?, ?)");
    for (let i = 0; i < 20; i++) insert.run(i, `value-${i}`, new Uint8Array([i, 0, 255]));
    db.exec("CREATE INDEX t_value ON t(value)");
    const beforeHistory = db.history.size;
    await handle.flush();
    expect(db.history.size).toBe(beforeHistory);
    expect(() =>
      db.transaction(() => {
        db.exec("DELETE FROM t");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    await handle.flush();
    insert.run(99, "after-save", new Uint8Array([99]));
    await handle.close();
    const reopened = await openDurableDatabase({ key: "database", backend });
    expect(reopened.value.query("SELECT id, value, data FROM t ORDER BY id")).toHaveLength(21);
    expect(reopened.value.query("SELECT data FROM t WHERE id = 4")).toEqual([{ data: new Uint8Array([4, 0, 255]) }]);
    expect(reopened.value.query("SELECT id FROM t WHERE value = 'after-save'")).toEqual([{ id: 99 }]);
    await reopened.close();
  });
}

test("durability refuses uncommitted transactions, then recovers after rollback", async () => {
  const backend = new MemoryDurabilityBackend();
  const handle = await openDurableDatabase({ key: "database", backend });
  handle.value.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  await handle.flush();
  handle.value.exec("BEGIN; INSERT INTO t VALUES (1)");
  await expect(handle.flush()).rejects.toThrow("transaction");
  handle.value.exec("ROLLBACK");
  await handle.close();
  const reopened = await openDurableDatabase({ key: "database", backend });
  expect(reopened.value.query("SELECT * FROM t")).toEqual([]);
  await reopened.close();
});
