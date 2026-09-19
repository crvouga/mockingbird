import { Database, Snapshot } from "@crvouga/postgres-mem";

export const STORAGE_KEY = "postgres-mem-example-snapshot";

const SEED_SQL = `
  CREATE TABLE authors (
    id serial PRIMARY KEY,
    name text NOT NULL UNIQUE,
    country text NOT NULL DEFAULT 'US'
  );
  CREATE TABLE articles (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    author_id int NOT NULL REFERENCES authors(id),
    title text NOT NULL,
    body text NOT NULL DEFAULT '',
    tags text[] NOT NULL DEFAULT '{}',
    price numeric(8,2),
    published_at timestamptz NOT NULL DEFAULT now(),
    meta jsonb NOT NULL DEFAULT '{}'
  );
`;

const SEED_AUTHORS: ReadonlyArray<[name: string, country: string]> = [
  ["Ada Lovelace", "GB"],
  ["Grace Hopper", "US"],
  ["Edsger Dijkstra", "NL"],
];

const SEED_ARTICLES: ReadonlyArray<
  [author: number, title: string, body: string, tags: string, price: string | null, publishedAt: string, meta: string]
> = [
  [
    1,
    "Postgres in memory",
    "A pure TypeScript PostgreSQL engine keeps the whole database in memory.",
    "{postgres,typescript}",
    "19.99",
    "2024-01-01T10:00:00Z",
    '{"category":"engineering","featured":true,"views":420}',
  ],
  [
    1,
    "Analytical engines",
    "Notes on computation, memory, and the first programs.",
    "{history,computing}",
    "9.50",
    "2024-01-02T09:30:00Z",
    '{"category":"history","featured":false,"views":97}',
  ],
  [
    2,
    "Compilers and COBOL",
    "From the first compiler to readable programs in plain language.",
    "{compilers,history}",
    "14.25",
    "2024-01-03T15:00:00Z",
    '{"category":"engineering","featured":true,"views":256}',
  ],
  [
    2,
    "Debugging the memory bank",
    "The famous moth, and why we still say bug.",
    "{debugging,history}",
    null,
    "2024-01-05T11:45:00Z",
    '{"category":"stories","featured":false,"views":512}',
  ],
  [
    3,
    "Structured programming in SQL",
    "Goto considered harmful, even in memory-resident query engines.",
    "{sql,essays}",
    "12.00",
    "2024-01-06T08:15:00Z",
    '{"category":"essays","featured":true,"views":301}',
  ],
];

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function createEngine(): Database {
  return new Database({ now: "system" });
}

export function seed(db: Database): void {
  db.exec(SEED_SQL);
  const insertAuthor = db.prepare("INSERT INTO authors (name, country) VALUES ($1, $2)");
  for (const [name, country] of SEED_AUTHORS) {
    insertAuthor.run(name, country);
  }
  const insertArticle = db.prepare(
    `INSERT INTO articles (author_id, title, body, tags, price, published_at, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  );
  for (const [author, title, body, tags, price, publishedAt, meta] of SEED_ARTICLES) {
    insertArticle.run(author, title, body, tags, price, publishedAt, meta);
  }
}

function createDatabase(): Database {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      return Snapshot.decode(base64ToBytes(saved)).open({ now: "system" });
    } catch {
      // Corrupt or incompatible snapshot — fall through to seed.
    }
  }
  const db = createEngine();
  seed(db);
  return db;
}

let db = createDatabase();

export function getDb(): Database {
  return db;
}

let cachedVersion: string | null = null;

/** Short engine banner, e.g. "PostgreSQL 18.3 (postgres-mem)". */
export function engineVersion(): string {
  if (cachedVersion === null) {
    const row = db.query<{ version: string }>("SELECT version()")[0];
    cachedVersion = String(row?.version ?? "").split(" on ")[0] ?? "";
  }
  return cachedVersion;
}

export function hasSavedSnapshot(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null;
}

export function savedSnapshotBytes(): number | null {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return null;
  try {
    return base64ToBytes(saved).byteLength;
  } catch {
    return null;
  }
}

export function saveSnapshot(): number {
  const snap = db.snapshot().encode();
  localStorage.setItem(STORAGE_KEY, bytesToBase64(snap));
  return snap.byteLength;
}

export function restoreSnapshot(): boolean {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return false;
  db.close();
  db = Snapshot.decode(base64ToBytes(saved)).open({ now: "system" });
  return true;
}

export function resetDatabase(): void {
  db.close();
  localStorage.removeItem(STORAGE_KEY);
  db = createEngine();
  seed(db);
}
