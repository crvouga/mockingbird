/**
 * Compile-only checks that the published `dist` types are complete and strict.
 * Run after `bun run build` via `bun run typecheck:package`.
 */
import { Database, PostgresError, Snapshot } from "../../dist/index.js";
import type {
  BindValue,
  DatabaseOptions,
  ErrorCategory,
  JsValue,
  QueryRow,
  ResultSet,
  RunResult,
  Statement,
} from "../../dist/index.js";
import { DEFAULT_NOW, DatabaseState, Prng, parse, tokenize } from "../../dist/unstable.js";
import type { TypedValue } from "../../dist/unstable.js";

const options: DatabaseOptions = {
  seed: 1,
  now: new Date("2012-06-15T12:34:56.000Z"),
};
const db = new Database(options);

db.exec(`
  CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL);
`);
db.prepare("INSERT INTO users (name) VALUES ($1)").run("Ada");

const rows: QueryRow[] = db.query("SELECT id, name FROM users");
const name: JsValue | undefined = rows[0]?.name;

const typed = db.query<{ id: number; name: string }>("SELECT id, name FROM users");
const id: number = typed[0]!.id;

const stmt: Statement = db.prepare("SELECT id, name FROM users WHERE id = $1");
const all: QueryRow[] = stmt.all(1);
const one: QueryRow | undefined = stmt.get(1);
const run: RunResult = db.prepare("INSERT INTO users (name) VALUES ($1)").run("Bob");
const rowCount: number = run.rowCount;
const command: string = run.command;
const result: ResultSet = stmt.result(1);
const columns: string[] = result.columns;
const columnTypes: string[] = result.columnTypes;

db.transaction(() => {
  db.prepare("INSERT INTO users (name) VALUES ($1)").run("Eve");
});

const copied: number = db.copyFrom("COPY users (name) FROM STDIN", "Zed\n");
const changes: number = db.changes;

const snap: Snapshot = db.snapshot();
const snapBytes: Uint8Array = snap.encode();
const fromSnap: Database = snap.open();
const fromBytes: Database = Snapshot.decode(snapBytes).open();
fromBytes.close();
fromSnap.close();
db.exec("CREATE TABLE extra (id int)");
db.registerFunction({
  name: "js_id",
  args: ["int4"],
  returns: "int4",
  fn: (n) => n,
});
const int8Db = new Database({ int8: "string" });
int8Db.close();

const seed: number | bigint = db.seed;
const defaultNow: Date = DEFAULT_NOW;
const _prng = new Prng(2);
void _prng;
const statements = parse("SELECT 1");
const tokens = tokenize("SELECT 1");
const state = new DatabaseState(new Prng(1), () => new Date(0));
void state;

try {
  db.exec("SELECT * FROM missing");
} catch (err) {
  if (err instanceof PostgresError) {
    const category: ErrorCategory = err.category;
    const message: string = err.message;
    const sqlState: string = err.sqlState;
    const code: string = err.code;
    void category;
    void message;
    void sqlState;
    void code;
  }
}

const bind: BindValue = 42n;
const tv: TypedValue | undefined = undefined;

void name;
void id;
void all;
void one;
void rowCount;
void command;
void columns;
void columnTypes;
void copied;
void changes;
void snap;
void seed;
void defaultNow;
void statements;
void tokens;
void bind;
void tv;
