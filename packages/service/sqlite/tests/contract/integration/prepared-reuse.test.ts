import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { setupBoth } from "../helpers.ts";

matrixBoth("prepared statements are reusable across many bind sets", (memory, sqlite) => {
  setupBoth(memory, sqlite, [
    "CREATE TABLE items(id INTEGER PRIMARY KEY, version INTEGER NOT NULL, payload TEXT NOT NULL)",
  ]);
  const memInsert = memory.prepare("INSERT INTO items(id, version, payload) VALUES (?, ?, ?)");
  const sqlInsert = sqlite.prepare("INSERT INTO items(id, version, payload) VALUES (?, ?, ?)");
  const memLookup = memory.prepare("SELECT id, version, payload FROM items WHERE id = ?");
  const sqlLookup = sqlite.prepare("SELECT id, version, payload FROM items WHERE id = ?");

  for (let id = 1; id <= 40; id++) {
    expectParity(memInsert.run(id, 1, `payload-${id}`), sqlInsert.run(id, 1, `payload-${id}`));
  }
  for (const id of [40, 1, 21, 7, 39]) {
    expectParity(memLookup.get(id), sqlLookup.get(id));
  }
});

matrixBoth("reused prepared statements observe ALTER TABLE schema invalidation", (memory, sqlite) => {
  setupBoth(memory, sqlite, [
    "CREATE TABLE items(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)",
    "INSERT INTO items(payload) VALUES ('before')",
  ]);
  const memSelect = memory.prepare("SELECT * FROM items ORDER BY id");
  const sqlSelect = sqlite.prepare("SELECT * FROM items ORDER BY id");
  const memInsert = memory.prepare("INSERT INTO items(payload) VALUES (?)");
  const sqlInsert = sqlite.prepare("INSERT INTO items(payload) VALUES (?)");

  expectParity(memSelect.all(), sqlSelect.all());
  const memAlter = memory.exec("ALTER TABLE items ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
  const sqlAlter = sqlite.exec("ALTER TABLE items ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
  expectParity({ ...memAlter, changes: 0, lastInsertRowid: 0 }, { ...sqlAlter, changes: 0, lastInsertRowid: 0 });
  expectParity(memInsert.run("after"), sqlInsert.run("after"));
  expectParity(memSelect.all(), sqlSelect.all());
});
