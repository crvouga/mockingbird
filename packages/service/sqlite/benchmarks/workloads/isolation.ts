import { Database, Snapshot } from "../../src/index.ts";
import type { BenchSpec } from "../harness/types.ts";
import { spec } from "./tiers.ts";

/** Fixed schema + row fill used as a migrate-seed proxy. */
const ISOLATION_USERS = 200;
const ISOLATION_ITEMS = 800;

const SCHEMA_DUMP = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_users_email ON users(email);
CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL
);
CREATE INDEX idx_items_user ON items(user_id);
`;

function fillIsolation(db: Database): void {
  const userIns = db.prepare("INSERT INTO users(id, email, name, created_at) VALUES (?, ?, ?, ?)");
  const itemIns = db.prepare("INSERT INTO items(id, user_id, title) VALUES (?, ?, ?)");
  db.transaction(() => {
    for (let i = 1; i <= ISOLATION_USERS; i++) {
      userIns.run(i, `u${i}@ex.test`, `User ${i}`, 1_700_000_000 + i);
    }
    for (let i = 1; i <= ISOLATION_ITEMS; i++) {
      itemIns.run(i, ((i - 1) % ISOLATION_USERS) + 1, `Item ${i}`);
    }
  });
}

function seedDatabase(): Database {
  const db = new Database();
  db.exec(SCHEMA_DUMP);
  fillIsolation(db);
  return db;
}

export function isolationSpecs(): BenchSpec[] {
  return [
    spec({
      name: "isolation/cold-migrate",
      operation: "exec schema dump + row fill",
      datasetSize: ISOLATION_USERS,
      tiers: ["ci", "default", "full"],
      engines: "mem",
      layer: "engine",
      isolateIterations: true,
      warmup: 1,
      iterations: 8,
      fn: () => {
        const db = new Database();
        db.exec(SCHEMA_DUMP);
        fillIsolation(db);
        db.close();
      },
    }),
    spec({
      name: "isolation/decode-open",
      operation: "Snapshot.decode(seedBytes).open()",
      datasetSize: ISOLATION_USERS,
      tiers: ["ci", "default", "full"],
      engines: "mem",
      layer: "engine",
      warmup: 2,
      iterations: 12,
      setup: () => {
        const seed = seedDatabase();
        const bytes = seed.snapshot().encode();
        seed.close();
        return { bytes };
      },
      fn: (_engine, ctx) => {
        const opened = Snapshot.decode((ctx as { bytes: Uint8Array }).bytes).open();
        opened.close();
      },
    }),
    spec({
      name: "isolation/snapshot-open",
      operation: "seed.open()",
      datasetSize: ISOLATION_USERS,
      tiers: ["ci", "default", "full"],
      engines: "mem",
      layer: "engine",
      warmup: 2,
      iterations: 20,
      setup: () => {
        const template = seedDatabase();
        const seed = template.snapshot();
        template.close();
        return { seed };
      },
      fn: (_engine, ctx) => {
        const child = (ctx as { seed: Snapshot }).seed.open();
        child.close();
      },
    }),
  ];
}
