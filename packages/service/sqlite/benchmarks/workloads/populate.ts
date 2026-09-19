import { mulberry32, pickInt, sentence } from "../harness/seed.ts";
import type { BenchEngine, BenchStatement } from "../harness/types.ts";

export function insertMany(engine: BenchEngine, sql: string, count: number, row: (i: number) => unknown[]): void {
  const stmt = engine.prepare(sql);
  engine.transaction(() => {
    for (let i = 1; i <= count; i++) stmt.run(...row(i));
  });
}

export function createUsersTable(engine: BenchEngine, withEmailIndex = true): void {
  engine.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  if (withEmailIndex) engine.exec("CREATE INDEX idx_users_email ON users(email)");
}

export function fillUsers(engine: BenchEngine, count: number, withEmailIndex = true): void {
  createUsersTable(engine, withEmailIndex);
  insertMany(engine, "INSERT INTO users(id, email, name, created_at) VALUES (?, ?, ?, ?)", count, (i) => [
    i,
    `u${i}@ex.test`,
    `User ${i}`,
    1_700_000_000 + i,
  ]);
}

export function createAppSchema(engine: BenchEngine): void {
  engine.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      assignee_id INTEGER,
      title TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_users_email ON users(email);
    CREATE INDEX idx_projects_owner ON projects(owner_id);
    CREATE INDEX idx_documents_project ON documents(project_id);
    CREATE INDEX idx_tasks_project ON tasks(project_id);
    CREATE INDEX idx_tasks_assignee ON tasks(assignee_id);
  `);
}

export function fillAppSchema(engine: BenchEngine, users: number): void {
  createAppSchema(engine);
  const rng = mulberry32(users * 997);
  const projects = Math.max(1, Math.floor(users / 5));
  const documents = users * 2;
  const tasks = users * 4;
  insertMany(engine, "INSERT INTO users(id, email, name) VALUES (?, ?, ?)", users, (i) => [
    i,
    `u${i}@ex.test`,
    `User ${i}`,
  ]);
  insertMany(engine, "INSERT INTO projects(id, owner_id, name) VALUES (?, ?, ?)", projects, (i) => [
    i,
    pickInt(rng, 1, users),
    `Project ${i}`,
  ]);
  insertMany(engine, "INSERT INTO documents(id, project_id, title, body) VALUES (?, ?, ?, ?)", documents, (i) => [
    i,
    pickInt(rng, 1, projects),
    `Doc ${i}`,
    sentence(rng, 12),
  ]);
  insertMany(
    engine,
    "INSERT INTO tasks(id, project_id, assignee_id, title, completed) VALUES (?, ?, ?, ?, ?)",
    tasks,
    (i) => [i, pickInt(rng, 1, projects), pickInt(rng, 1, users), `Task ${i}`, i % 4 === 0 ? 1 : 0],
  );
}

export function fillJsonDocs(engine: BenchEngine, count: number): void {
  engine.exec("CREATE TABLE docs (id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
  insertMany(engine, "INSERT INTO docs(id, data) VALUES (?, ?)", count, (i) => [
    i,
    JSON.stringify({ id: i, name: `doc-${i}`, tags: ["a", "b", i % 3], nested: { score: i % 100 } }),
  ]);
}

export function fillFts(engine: BenchEngine, count: number): void {
  engine.exec("CREATE VIRTUAL TABLE docs USING fts5(content)");
  const rng = mulberry32(count + 42);
  insertMany(engine, "INSERT INTO docs(content) VALUES (?)", count, () => [sentence(rng, 10)]);
}

export function fillPayload(engine: BenchEngine, rows: number, payloadBytes: number): void {
  engine.exec("CREATE TABLE blobs (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
  const text = "y".repeat(payloadBytes);
  insertMany(engine, "INSERT INTO blobs(id, payload) VALUES (?, ?)", rows, (i) => [i, text]);
}

export interface PreparedCtx {
  stmt: BenchStatement;
  id: number;
  n: number;
}

export function pkLookupCtx(engine: BenchEngine, n: number): PreparedCtx {
  fillUsers(engine, n);
  return { stmt: engine.prepare("SELECT id, name FROM users WHERE id = ?"), id: Math.max(1, Math.floor(n / 2)), n };
}
