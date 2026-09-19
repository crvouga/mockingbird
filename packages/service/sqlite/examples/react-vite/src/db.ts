import { Database, Snapshot } from "@crvouga/sqlite-mem";

export const STORAGE_KEY = "sqlite-mem-example-snapshot";

const SEED_SQL = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE posts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    title TEXT
  );
`;

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
  return new Database({ now: () => new Date() });
}

export function seed(db: Database): void {
  db.exec(SEED_SQL);
  const insertUser = db.prepare("INSERT INTO users(name) VALUES (?)");
  insertUser.run("Alice");
  insertUser.run("Bob");
  const insertPost = db.prepare("INSERT INTO posts(user_id, title) VALUES (?, ?)");
  insertPost.run(1, "Hello");
  insertPost.run(1, "World");
}

function createDatabase(): Database {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      return Snapshot.decode(base64ToBytes(saved)).open({ now: () => new Date() });
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
  db = Snapshot.decode(base64ToBytes(saved)).open({ now: () => new Date() });
  return true;
}

export function resetDatabase(): void {
  db.close();
  localStorage.removeItem(STORAGE_KEY);
  db = createEngine();
  seed(db);
}
