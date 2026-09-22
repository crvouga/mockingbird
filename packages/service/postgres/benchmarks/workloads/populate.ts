import { mulberry32, pickInt, sentence } from "../harness/seed.ts";
import type { BenchEngine, BenchStatement } from "../harness/types.ts";

export async function insertMany(
  engine: BenchEngine,
  sql: string,
  count: number,
  row: (i: number) => unknown[],
): Promise<void> {
  const stmt = engine.prepare(sql);
  await engine.transaction(async () => {
    for (let i = 1; i <= count; i++) await stmt.run(...row(i));
  });
}

export async function createUsersTable(engine: BenchEngine, withEmailIndex = true): Promise<void> {
  await engine.exec(`CREATE TABLE users (
    id serial PRIMARY KEY,
    email text NOT NULL,
    name text NOT NULL,
    created_at int NOT NULL
  )`);
  if (withEmailIndex) await engine.exec("CREATE INDEX idx_users_email ON users(email)");
}

export async function fillUsers(engine: BenchEngine, count: number, withEmailIndex = true): Promise<void> {
  await createUsersTable(engine, withEmailIndex);
  // serial assigns ids 1..count deterministically
  await insertMany(engine, "INSERT INTO users(email, name, created_at) VALUES ($1, $2, $3)", count, (i) => [
    `u${i}@ex.test`,
    `User ${i}`,
    1_700_000_000 + i,
  ]);
}

export async function createAppSchema(engine: BenchEngine): Promise<void> {
  await engine.exec(`
    CREATE TABLE users (
      id serial PRIMARY KEY,
      email text NOT NULL,
      name text NOT NULL
    );
    CREATE TABLE orders (
      id serial PRIMARY KEY,
      user_id int NOT NULL,
      status text NOT NULL,
      created_at int NOT NULL
    );
    CREATE TABLE items (
      id serial PRIMARY KEY,
      order_id int NOT NULL,
      product text NOT NULL,
      qty int NOT NULL,
      price_cents int NOT NULL
    );
    CREATE INDEX idx_users_email ON users(email);
    CREATE INDEX idx_orders_user ON orders(user_id);
    CREATE INDEX idx_orders_status ON orders(status);
    CREATE INDEX idx_items_order ON items(order_id);
  `);
}

const ORDER_STATUSES = ["pending", "paid", "shipped"] as const;

export async function fillAppSchema(engine: BenchEngine, users: number): Promise<void> {
  await createAppSchema(engine);
  const rng = mulberry32(users * 997);
  const orders = users * 2;
  const items = users * 4;
  await insertMany(engine, "INSERT INTO users(email, name) VALUES ($1, $2)", users, (i) => [
    `u${i}@ex.test`,
    `User ${i}`,
  ]);
  await insertMany(engine, "INSERT INTO orders(user_id, status, created_at) VALUES ($1, $2, $3)", orders, (i) => [
    pickInt(rng, 1, users),
    ORDER_STATUSES[i % ORDER_STATUSES.length],
    1_700_000_000 + i,
  ]);
  await insertMany(
    engine,
    "INSERT INTO items(order_id, product, qty, price_cents) VALUES ($1, $2, $3, $4)",
    items,
    (i) => [pickInt(rng, 1, orders), `Product ${i % 50}`, pickInt(rng, 1, 5), pickInt(rng, 100, 10_000)],
  );
}

export async function fillJsonDocs(engine: BenchEngine, count: number): Promise<void> {
  await engine.exec("CREATE TABLE docs (id int PRIMARY KEY, data jsonb NOT NULL)");
  await insertMany(engine, "INSERT INTO docs(id, data) VALUES ($1, $2::jsonb)", count, (i) => [
    i,
    JSON.stringify({
      id: i,
      name: `doc-${i}`,
      flag: i % 10 === 0,
      tags: ["a", "b", i % 3],
      nested: { score: i % 100 },
    }),
  ]);
}

export async function fillArticles(engine: BenchEngine, count: number): Promise<void> {
  await engine.exec("CREATE TABLE articles (id int PRIMARY KEY, body text NOT NULL, tsv tsvector NOT NULL)");
  const rng = mulberry32(count + 42);
  await insertMany(
    engine,
    "INSERT INTO articles(id, body, tsv) VALUES ($1, $2, to_tsvector('english', $2))",
    count,
    (i) => [i, sentence(rng, 10)],
  );
}

export async function fillPayload(engine: BenchEngine, rows: number, payloadBytes: number): Promise<void> {
  await engine.exec("CREATE TABLE blobs (id int PRIMARY KEY, payload text NOT NULL)");
  const text = "y".repeat(payloadBytes);
  await insertMany(engine, "INSERT INTO blobs(id, payload) VALUES ($1, $2)", rows, (i) => [i, text]);
}

export interface PreparedCtx {
  stmt: BenchStatement;
  id: number;
  n: number;
}

export async function pkLookupCtx(engine: BenchEngine, n: number): Promise<PreparedCtx> {
  await fillUsers(engine, n);
  return { stmt: engine.prepare("SELECT id, name FROM users WHERE id = $1"), id: Math.max(1, Math.floor(n / 2)), n };
}
