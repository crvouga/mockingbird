import { expect, test } from "bun:test";
import {
  Database,
  type DurabilityBackend,
  type DurablePatch,
  MemoryDurabilityBackend,
  openBufferedDurableDatabase,
  openDurableDatabase,
  readDurableJournal,
  Snapshot,
  unpackDurableRecord,
} from "../../../src/index.ts";

const scheduler = { schedule: () => 0, cancel: () => {} };
const insertSql = "INSERT INTO t VALUES (?, ?, ?, ?, ?)";
const updateSql = "UPDATE t SET value = ? WHERE id = ?";

function backend() {
  const memory = new MemoryDurabilityBackend();
  const patches: DurablePatch[] = [];
  const value: DurabilityBackend = {
    load: (key) => memory.load(key),
    commit(key, revision, patch) {
      patches.push(patch);
      return memory.commit(key, revision, patch);
    },
  };
  return { value, memory, patches };
}

test("buffered rows, indexes, types, rollback, schema changes and compaction recover", async () => {
  const storage = backend();
  const handle = await openBufferedDurableDatabase({
    key: "t",
    backend: storage.value,
    scheduler,
    compactAfterBatches: 2,
  });
  const db = handle.value;
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT, k INTEGER UNIQUE, b BLOB, n REAL)");
  const insert = db.prepare(insertSql);
  db.transaction(() => {
    for (let i = 0; i < 4200; i++) insert.run(i, `row-${i}`, i, new Uint8Array([i % 251]), i + 0.5);
  });
  await handle.flush();
  storage.patches.length = 0;
  let fullEncodes = 0;
  const encode = Snapshot.prototype.encode;
  Snapshot.prototype.encode = function () {
    fullEncodes++;
    return encode.call(this);
  };
  try {
    const update = db.prepare(updateSql);
    for (let i = 0; i < 100; i++) update.run(`last-${i}`, 0);
    db.exec(
      "BEGIN; UPDATE t SET value = 'lost' WHERE id = 1; SAVEPOINT s; DELETE FROM t WHERE id = 2; ROLLBACK TO s; RELEASE s; ROLLBACK",
    );
    db.exec("DELETE FROM t WHERE id = 3; INSERT INTO t VALUES (6000,'new',6000,NULL,NULL)");
    await handle.flush();
    expect(fullEncodes).toBe(0);
    expect(storage.patches.length).toBe(1);
    expect(storage.patches[0]!.pages.reduce((n, page) => n + page.bytes.length, 0)).toBeLessThanOrEqual(65536);
    for (let i = 0; i < 4; i++) {
      update.run(`compact-${i}`, 4);
      await handle.flush();
    }
    expect(fullEncodes).toBeGreaterThan(0);
    db.exec("ALTER TABLE t ADD COLUMN extra INTEGER DEFAULT 7");
    await handle.flush();
    const afterSchema = fullEncodes;
    update.run("after schema", 0);
    await handle.flush();
    expect(fullEncodes).toBe(afterSchema);
    const expected = db.query("SELECT * FROM t ORDER BY id");
    const prngState = db.prng.getState();
    await handle.close();
    // The existing opener reads journals, preserves its complete checkpoint metadata.
    const reopened = await openDurableDatabase({ key: "t", backend: storage.value });
    try {
      expect(reopened.value.query("SELECT * FROM t ORDER BY id")).toEqual(expected);
      expect(reopened.value.query("SELECT value FROM t WHERE k = 6000")).toEqual([{ value: "new" }]);
      expect(reopened.value.prng.getState()).toBe(prngState);
    } finally {
      await reopened.close();
    }
    const image = (await storage.memory.load("t"))!;
    const checkpoint = readDurableJournal(image.bytes)?.[0];
    if (!checkpoint) throw new Error("Missing retained checkpoint");
    const legacy = Snapshot.decode(unpackDurableRecord(checkpoint).snapshot).open();
    expect(legacy.query("SELECT value FROM t WHERE id = 0")).toEqual([{ value: "after schema" }]);
    legacy.close();
  } finally {
    Snapshot.prototype.encode = encode;
  }
});

test("an in-flight save keeps subsequent mutations and snapshot branches independent", async () => {
  const memory = new MemoryDurabilityBackend();
  let release: (() => void) | undefined;
  let block = false;
  const storage: DurabilityBackend = {
    load: (key) => memory.load(key),
    async commit(key, revision, patch) {
      if (block)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return memory.commit(key, revision, patch);
    },
  };
  const handle = await openBufferedDurableDatabase({ key: "t", backend: storage, scheduler });
  const db = handle.value;
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO t VALUES (1,'before')");
  await handle.flush();
  const historical = db.snapshot();
  db.exec("UPDATE t SET value = 'first' WHERE id = 1");
  block = true;
  const first = handle.flush();
  await Bun.sleep(0);
  db.exec("UPDATE t SET value = 'second' WHERE id = 1; INSERT INTO t VALUES (2,'new')");
  block = false;
  release!();
  await first;
  expect(handle.pending).toBe(true);
  await handle.flush();
  const branch = historical.open();
  expect(branch.query("SELECT value FROM t")).toEqual([{ value: "before" }]);
  branch.exec("UPDATE t SET value = 'branch' WHERE id = 1");
  expect(db.query("SELECT value FROM t WHERE id = 1")).toEqual([{ value: "second" }]);
  branch.close();
  await handle.close();
  const reopened = await openBufferedDurableDatabase({ key: "t", backend: storage, scheduler });
  expect(reopened.value.query("SELECT * FROM t ORDER BY id")).toEqual([
    { id: 1, value: "second" },
    { id: 2, value: "new" },
  ]);
  await reopened.close();
});

test("explicit flush rejects open transactions and failed close remains retryable", async () => {
  const storage = backend();
  const handle = await openBufferedDurableDatabase({ key: "t", backend: storage.value, scheduler });
  handle.value.exec("CREATE TABLE t(id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1)");
  await handle.flush();
  handle.value.exec("BEGIN; INSERT INTO t VALUES (2)");
  await expect(handle.flush()).rejects.toThrow("transaction");
  await expect(handle.close()).rejects.toThrow("transaction");
  handle.value.exec("ROLLBACK");
  await handle.close();
  const reopened = await openBufferedDurableDatabase({ key: "t", backend: storage.value, scheduler });
  expect(reopened.value.query("SELECT * FROM t")).toEqual([{ id: 1 }]);
  await reopened.close();
});

test("journal metadata retains triggers, PRNG, pragmas, and native-state exposure falls back", async () => {
  const storage = backend();
  const handle = await openBufferedDurableDatabase({ key: "t", backend: storage.value, scheduler });
  const db = handle.value;
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, n REAL); CREATE TABLE audit(id INTEGER, n REAL)");
  db.exec("CREATE TRIGGER record_insert AFTER INSERT ON t BEGIN INSERT INTO audit VALUES (new.id, 1.0); END");
  db.exec("PRAGMA user_version = 42; PRAGMA case_sensitive_like = ON");
  await handle.flush();
  db.exec("INSERT INTO t VALUES (1,2.5)");
  db.query("SELECT random()");
  await handle.flush();
  const prng = db.prng.getState();
  await handle.close();
  const reopened = await openBufferedDurableDatabase({ key: "t", backend: storage.value, scheduler });
  expect(reopened.value.prng.getState()).toBe(prng);
  expect(reopened.value.query("PRAGMA user_version")).toEqual([{ user_version: 42 }]);
  expect(reopened.value.query("SELECT 'A' LIKE 'a' AS matched")).toEqual([{ matched: 0 }]);
  reopened.value.exec("INSERT INTO t VALUES (2,3.5)");
  expect(reopened.value.query("SELECT id, typeof(n) AS kind FROM audit ORDER BY id")).toEqual([
    { id: 1, kind: "real" },
    { id: 2, kind: "real" },
  ]);
  const native = reopened.value.state.getTable("t").rows;
  native.set(3, { rowid: 3, values: [3, 4.5] });
  await reopened.flush();
  await reopened.close();
  const final = await openDurableDatabase({ key: "t", backend: storage.value });
  expect(final.value.query("SELECT n FROM t WHERE id = 3")).toEqual([{ n: 4.5 }]);
  await final.close();
});

test("borrowed binary mutations remain visible to buffered persistence", async () => {
  const storage = backend();
  const handle = await openBufferedDurableDatabase({ key: "binary", backend: storage.value, scheduler });
  const db = handle.value;
  db.exec("CREATE TABLE binary_values(id INTEGER PRIMARY KEY, b BLOB)");
  const input = new Uint8Array([1, 2, 3]);
  db.prepare("INSERT INTO binary_values VALUES (1, ?)").run(input);
  await handle.flush();
  input[0] = 7;
  const row = db.query<{ b: Uint8Array }>("SELECT b FROM binary_values")[0]!;
  const expectedInput = row.b[0];
  expect(expectedInput).toBe(1);
  row.b[1] = 8;
  await handle.flush();
  await handle.close();
  const reopened = await openBufferedDurableDatabase({ key: "binary", backend: storage.value, scheduler });
  expect(reopened.value.query("SELECT b FROM binary_values")).toEqual([{ b: new Uint8Array([expectedInput!, 8, 3]) }]);
  await reopened.close();
});

test("physical journals recover mixed upserts, foreign-key cascades and rollback histories", async () => {
  const storage = backend();
  const options = { key: "mixed", backend: storage.value, scheduler, compactAfterBatches: 7 };
  let handle = await openBufferedDurableDatabase(options);
  const reference = new Database();
  const schema =
    "CREATE TABLE parent(id INTEGER PRIMARY KEY, value INTEGER); " +
    "CREATE TABLE child(id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id) ON UPDATE CASCADE ON DELETE CASCADE, value INTEGER)";
  const exec = (sql: string) => {
    reference.exec(sql);
    handle.value.exec(sql);
  };
  exec("PRAGMA foreign_keys = ON");
  exec(schema);
  for (let i = 0; i < 30; i++) exec(`INSERT INTO parent VALUES (${i},0); INSERT INTO child VALUES (${i},${i},0)`);
  await handle.flush();
  for (let step = 0; step < 100; step++) {
    const id = (step * 17) % 30;
    switch (step % 5) {
      case 0:
        exec(
          `UPDATE parent SET id = ${id + 100} WHERE id = ${id}; UPDATE parent SET id = ${id} WHERE id = ${id + 100}`,
        );
        break;
      case 1:
        exec(`INSERT INTO parent VALUES (${id},${step}) ON CONFLICT(id) DO UPDATE SET value = excluded.value`);
        break;
      case 2:
        exec(`DELETE FROM parent WHERE id = ${id}`);
        break;
      case 3:
        exec(`BEGIN; UPDATE parent SET value = -1; SAVEPOINT s; DELETE FROM child; ROLLBACK TO s; RELEASE s; ROLLBACK`);
        break;
      case 4:
        exec(`INSERT INTO child SELECT ${100 + step}, id, ${step} FROM parent WHERE id = ${id}`);
        break;
    }
    if (step % 9 === 0 || step === 99) {
      await handle.close();
      handle = await openBufferedDurableDatabase(options);
      for (const table of ["parent", "child"]) {
        expect(handle.value.query(`SELECT * FROM ${table} ORDER BY id`)).toEqual(
          reference.query(`SELECT * FROM ${table} ORDER BY id`),
        );
      }
    } else if (step % 3 === 0) await handle.flush();
  }
  reference.close();
  await handle.close();
});
