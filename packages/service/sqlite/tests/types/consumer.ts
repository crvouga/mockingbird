/**
 * Compile-only checks that the published `dist` types are complete and strict.
 * Run after `bun run build` via `bun run typecheck:package`.
 */
import { Database, Snapshot, SqliteError, Statement } from "../../dist/index.js";
import type {
  BindValue,
  DatabaseOptions,
  ErrorCategory,
  QueryRow,
  QueryValue,
  ResultSet,
  RunResult,
} from "../../dist/index.js";
import {
  DEFAULT_DATABASE_SEED,
  DEFAULT_NOW,
  parse,
  Prng,
  SqlJsonText,
  SqlReal,
  tokenize,
} from "../../dist/unstable.js";
import type { ParsedStatement, Token } from "../../dist/unstable.js";

const options: DatabaseOptions = {
  seed: 1,
  now: new Date("2012-06-15T12:34:56.000Z"),
};
const db = new Database(options);

db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
`);
db.prepare("INSERT INTO users (name) VALUES (?)").run("Ada");

const rows: QueryRow[] = db.query("SELECT id, name FROM users");
const name: QueryValue | undefined = rows[0]?.name;

const typed = db.query<{ id: number; name: string }>("SELECT id, name FROM users");
const id: number = typed[0]!.id;

const stmt: Statement = db.prepare("SELECT id, name FROM users WHERE id = ?");
const all: QueryRow[] = stmt.all(1);
const one: QueryRow | undefined = stmt.get(1);
const run: RunResult = db.prepare("INSERT INTO users (name) VALUES (?)").run("Bob");
const changes: number = run.changes;
const lastId: number | bigint = run.lastInsertRowid;
const result: ResultSet = stmt.result(1);
const columns: string[] = result.columns;
const values: QueryValue[][] = result.values;

db.transaction(() => {
  db.prepare("INSERT INTO users (name) VALUES (?)").run("Eve");
});

const snap: Snapshot = db.snapshot();
const snapBytes: Uint8Array = snap.encode();
const fromSnap: Database = snap.open();
const fromBytes: Database = Snapshot.decode(snapBytes).open();
fromBytes.close();
fromSnap.close();

const seed: number | bigint = db.seed;
const defaultSeed: number = DEFAULT_DATABASE_SEED;
const defaultNow: Date = DEFAULT_NOW;
const _prng = new Prng(2);
void _prng;

try {
  db.exec("SELECT * FROM missing");
} catch (err) {
  if (err instanceof SqliteError) {
    const category: ErrorCategory = err.category;
    const message: string = err.message;
    const sqliteCode: string = err.sqliteCode;
    const code: string = err.code;
    void category;
    void message;
    void sqliteCode;
    void code;
  }
}

const ast: ParsedStatement[] = parse("SELECT 1 AS n");
const tokens: Token[] = tokenize("SELECT 1");
const bindable: BindValue[] = [null, 1, 1n, "text", true, new Uint8Array([1]), new ArrayBuffer(2)];
db.query("SELECT ?", bindable);
void new SqlReal(1);
void new SqlJsonText("{}");

db.close();

void all;
void ast;
void changes;
void columns;
void defaultNow;
void defaultSeed;
void id;
void lastId;
void name;
void one;
void result;
void seed;
void tokens;
void typed;
void values;

// @ts-expect-error Statement is only constructed via Database.prepare
new Statement();

// @ts-expect-error factory is stripped from the published types
Statement.create(db, "SELECT 1", []);

// @ts-expect-error Statement.bind was removed from the public API
stmt.bind(1);

// @ts-expect-error exec does not accept bind parameters
db.exec("SELECT ?", [1]);

// @ts-expect-error objects are not valid bind parameters
db.query("SELECT ?", [{ nested: true }]);

// @ts-expect-error Dates are not valid bind parameters
db.query("SELECT ?", [new Date()]);

// @ts-expect-error prng option was removed
new Database({ prng: new Prng(2) });

const closed = new Database();
closed.close();

// Internal engine state is omitted from the published .d.ts
const internalDb = new Database();
// @ts-expect-error catalog state is not part of the public type surface
internalDb.state;
// @ts-expect-error PRNG is configured via constructor options, not a public field
internalDb.prng;
// @ts-expect-error clock is configured via constructor options, not a public field
internalDb.now;
// @ts-expect-error transaction manager is not part of the public type surface
internalDb.transactions;
