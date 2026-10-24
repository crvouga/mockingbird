import { type BufferedDurabilityObserver, type Checkpoint, Timeline } from "@crvouga/mockingbird-core";
import { SqliteError } from "../errors/index.ts";
import { parseUnits } from "../parser/index.ts";
import {
  type Clock,
  type DatabaseOptions,
  DEFAULT_DATABASE_SEED,
  fixedClock,
  OsEntropy,
  Prng,
  type RandomMode,
  resolveClock,
} from "../runtime/index.ts";
import { DatabaseState } from "../storage/database-state.ts";
import { TransactionManager } from "../transactions/manager.ts";
import type { BindValue, QueryRow } from "../types/value.ts";
import { captureSnapshot, type Snapshot } from "./snapshot.ts";
import { Statement } from "./statement.ts";

const ADOPT = Symbol("sqlite-mem.adopt");

interface AdoptedDatabase {
  readonly [ADOPT]: true;
  readonly state: DatabaseState;
  readonly prng: Prng;
  readonly now: Clock;
  readonly seed: number | bigint;
  readonly randomMode: RandomMode;
  readonly systemClock: boolean;
}

/** A timeline checkpoint without its retained snapshot value. */
export interface HistoryCheckpoint {
  id: string;
  branch: string;
  parent: string | null;
  at: number;
}

/** Branch heads and checkpoints owned by the shared Timeline. */
export interface DatabaseHistory {
  readonly size: number;
  head(branch?: string): HistoryCheckpoint | undefined;
  branches(): Readonly<Record<string, string>>;
  checkpoints(): readonly HistoryCheckpoint[];
}

/** Additive time-travel controls for read APIs. */
export interface QueryOptions {
  /**
   * Execute against this immutable snapshot, or a timeline checkpoint id,
   * instead of the live database.
   */
  at?: Snapshot | string;
}

/**
 * Pure TypeScript in-memory SQLite database.
 *
 * Deterministic by default: `random()` / `randomblob()` use a seeded PRNG
 * (`seed` defaults to `1`) and `date('now')` / friends use a fixed clock
 * (`2000-01-01T00:00:00.000Z`). Pass `{ random: "os" }` and `{ now: "system" }`
 * for SQLite-like CSPRNG and wall-clock `'now'`. There is no filesystem or WASM.
 *
 * @example
 * ```ts
 * import { Database } from "@crvouga/mockingbird-service-sqlite";
 *
 * const db = new Database();
 * db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
 * db.prepare("INSERT INTO users (name) VALUES (?)").run("Alice");
 * const users = db.query<{ id: number; name: string }>("SELECT * FROM users");
 * ```
 */
export class Database {
  /** @internal Engine catalog, tables, and mutation counters. */
  readonly state: DatabaseState;
  /** @internal Engine-only access; buffered mode observes public state exposure. */
  readonly engineState: DatabaseState;
  /** @internal Installed only by buffered durability. */
  durabilityObserver?: BufferedDurabilityObserver;
  /** Seed used to construct the PRNG. Ignored when {@link randomMode} is `"os"`. */
  readonly seed: number | bigint;
  /** Entropy mode for `random()` / `randomblob()`. */
  readonly randomMode: RandomMode;
  /**
   * When true, `'now'` follows the wall clock and is not frozen by {@link Snapshot.open}.
   * @internal
   */
  readonly systemClock: boolean;
  /**
   * PRNG backing `random()` / `randomblob()` and related builtins.
   * Prefer passing `seed` / `random` to the constructor.
   * @internal
   */
  readonly prng: Prng;
  /**
   * Clock used by `date('now')` / `datetime('now')` / `CURRENT_TIMESTAMP`.
   * Prefer passing `now` to the constructor.
   * @internal
   */
  now: Clock;
  /** @internal Transaction / savepoint manager. */
  readonly transactions: TransactionManager;
  private closed = false;
  private transactionSequence = 0;
  /** Depth of active {@link transaction} callbacks (not SQL BEGIN). */
  private apiTransactionDepth = 0;
  /** @internal Shared checkpoint DAG. Omitted from published declarations. */
  readonly timeline: Timeline<Snapshot>;
  private historyBranch = "main";
  private originId = "";

  /**
   * Create an empty in-memory database.
   *
   * @param options - Determinism knobs. See {@link DatabaseOptions}.
   */
  constructor(options: DatabaseOptions = {}) {
    if (isAdopted(options)) {
      this.seed = options.seed;
      this.randomMode = options.randomMode;
      this.systemClock = options.systemClock;
      this.prng = options.prng;
      this.now = options.now;
      this.engineState = options.state;
      this.transactions = new TransactionManager(this.engineState, this.prng);
    } else {
      this.seed = options.seed ?? DEFAULT_DATABASE_SEED;
      this.randomMode = options.random ?? "deterministic";
      this.systemClock = options.now === "system";
      this.prng = this.randomMode === "os" ? new OsEntropy() : new Prng(this.seed);
      this.now = resolveClock(options.now);
      this.engineState = new DatabaseState();
      this.transactions = new TransactionManager(this.engineState, this.prng);
    }
    this.state = this.engineState;
    this.timeline = new Timeline<Snapshot>({
      now: () => this.now().getTime(),
      ...(options.maxCheckpoints !== undefined ? { maxCheckpoints: options.maxCheckpoints } : {}),
    });
    const origin = this.timeline.commit(this.captureLive());
    this.originId = origin.id;
    this.timeline.retain(origin.id);
  }

  /**
   * Execute SQL for its side effects (DDL/DML). Multiple statements are allowed.
   *
   * Does not accept bind parameters — use {@link prepare} or {@link query}.
   *
   * @param sql - SQL to run (semicolon-separated statements are ok).
   * @throws {SqliteError} If the database is closed, extra arguments are passed, or the SQL fails.
   */
  exec(sql: string): void {
    this.assertOpen();
    // Runtime guard: TypeScript rejects a second argument; JS callers must still get misuse.
    // biome-ignore lint/complexity/noArguments: intentional arity check for the frozen exec(sql) signature
    if (arguments.length > 1) {
      throw new SqliteError("exec() does not accept parameters; use prepare() or query()", "misuse");
    }
    Statement.createFromSql(this, sql).run();
  }

  /**
   * Execute a single-statement query and return all rows as objects keyed by column name.
   *
   * @typeParam T - Row shape. Defaults to {@link QueryRow}.
   * @param sql - A single SQL statement (trailing `;` is fine).
   * @param params - Bound parameters for `?` / `:name` placeholders.
   * @returns All result rows.
   * @throws {SqliteError} If the database is closed, `sql` is not a single statement, or execution fails.
   */
  query<T = QueryRow>(sql: string, params: readonly BindValue[] = [], options: QueryOptions = {}): T[] {
    this.assertOpen();
    const at = options.at;
    if (typeof at === "string") {
      try {
        return this.timeline.get(at).value.open().query<T>(sql, params);
      } catch (error) {
        this.historyError(error);
      }
    }
    if (at) return at.open().query<T>(sql, params);
    return this.prepareSingle(sql).all<T>(...params);
  }

  /**
   * Compile a single SQL statement into a reusable {@link Statement}.
   *
   * @param sql - A single SQL statement (trailing `;` is fine). Multi-statement scripts are rejected.
   * @throws {SqliteError} If the database is closed or `sql` cannot be prepared as one statement.
   */
  prepare(sql: string): Statement {
    this.assertOpen();
    return this.prepareSingle(sql);
  }

  /**
   * Run `fn` inside a transaction. Commits on success; rolls back if `fn` throws.
   *
   * Nested calls use SAVEPOINTs so an inner failure does not abort the outer
   * transaction. Calling {@link close} from inside `fn` throws `misuse`.
   *
   * @param fn - Work to run while the transaction is open.
   * @returns The value returned by `fn`.
   * @throws {SqliteError} If the database is closed. Re-throws whatever `fn` throws after rollback.
   */
  transaction<T>(fn: () => T): T {
    this.assertOpen();
    this.durabilityObserver?.assertWritable();
    this.apiTransactionDepth++;
    try {
      if (!this.transactions.inTransaction) {
        this.transactions.begin();
        try {
          const value = fn();
          this.transactions.commit();
          return value;
        } catch (error) {
          this.transactions.rollback();
          throw error;
        }
      }
      const name = `__api_transaction_${++this.transactionSequence}`;
      this.transactions.savepoint(name);
      try {
        const value = fn();
        this.transactions.release(name);
        return value;
      } catch (error) {
        this.transactions.rollback(name);
        this.transactions.release(name);
        throw error;
      }
    } finally {
      this.apiTransactionDepth--;
      this.durabilityObserver?.changed();
    }
  }

  /**
   * Freeze this database into a reusable {@link Snapshot} template.
   *
   * Does not encode SQLM bytes. Call {@link Snapshot.encode} to persist, or
   * {@link Snapshot.open} for a copy-on-write fork.
   *
   * @throws {SqliteError} If the database is closed or a transaction is open.
   */
  snapshot(): Snapshot {
    const point = this.record(this.historyBranch);
    return this.timeline.get(point.id).value;
  }

  /** Alias for {@link snapshot}, naming the value as a timeline checkpoint. */
  checkpoint(): Snapshot {
    return this.snapshot();
  }

  /**
   * Commit the live state onto `branch` (default: the branch this database follows).
   * Does not switch the live database. Illegal inside a transaction.
   */
  record(branch = this.historyBranch): HistoryCheckpoint {
    this.assertOpen();
    if (this.transactions.inTransaction) {
      throw new SqliteError("cannot snapshot during a transaction", "transaction");
    }
    try {
      return project(this.timeline.commit(this.captureLive(), { branch }));
    } catch (error) {
      this.historyError(error);
    }
  }

  /** Point `name` at a checkpoint without copying rows or switching the live database. */
  fork(name: string, at?: string): HistoryCheckpoint {
    this.assertOpen();
    try {
      const point = this.timeline.fork(name, at !== undefined ? { from: at } : {});
      if (!point) throw new SqliteError("no checkpoint to fork from", "misuse");
      return project(point);
    } catch (error) {
      if (error instanceof SqliteError) throw error;
      this.historyError(error);
    }
  }

  /** Move `branch` to `id` and install that checkpoint as the live database. */
  checkout(id: string, branch = this.historyBranch): HistoryCheckpoint {
    this.assertOpen();
    if (this.transactions.inTransaction) {
      throw new SqliteError("cannot checkout during a transaction", "transaction");
    }
    try {
      const point = this.timeline.checkout(branch, id);
      this.historyBranch = branch;
      this.install(point.value);
      return project(point);
    } catch (error) {
      this.historyError(error);
    }
  }

  /** Return the live database to the origin checkpoint on `main`. */
  reset(): HistoryCheckpoint {
    return this.checkout(this.originId, "main");
  }

  /** Checkpoint ids and branch heads. Values stay inside the timeline. */
  get history(): DatabaseHistory {
    const timeline = this.timeline;
    return {
      get size() {
        return timeline.size;
      },
      head(branch?: string) {
        const point = timeline.head(branch);
        return point ? project(point) : undefined;
      },
      branches() {
        return timeline.branches();
      },
      checkpoints() {
        return timeline.checkpoints().map(project);
      },
    };
  }

  /** Open a copy-on-write branch from `at`, or from the current state when omitted. */
  branch(at: Snapshot = this.snapshot()): Database {
    this.assertOpen();
    return at.open();
  }

  /**
   * Close the database. Further SQL throws {@link SqliteError}. Idempotent.
   *
   * Rolls back an open SQL transaction, if any. Throws if called from inside
   * a {@link transaction} callback.
   */
  close(): void {
    if (this.closed) return;
    if (this.apiTransactionDepth > 0) {
      throw new SqliteError("cannot close database inside transaction()", "misuse");
    }
    if (this.transactions.inTransaction) this.transactions.rollback();
    this.closed = true;
    this.durabilityObserver?.closed?.();
  }

  /**
   * Rows changed by the most recent INSERT / UPDATE / DELETE (SQLite `changes()`).
   *
   * @throws {SqliteError} If the database is closed.
   */
  get changes(): number {
    this.assertOpen();
    return this.engineState.changes;
  }

  /**
   * Rowid of the most recent INSERT (SQLite `last_insert_rowid()`).
   *
   * @throws {SqliteError} If the database is closed.
   */
  get lastInsertRowid(): number | bigint {
    this.assertOpen();
    return this.engineState.lastInsertRowid;
  }

  /**
   * Cumulative rows changed by INSERT / UPDATE / DELETE (SQLite `total_changes()`).
   *
   * @throws {SqliteError} If the database is closed.
   */
  get totalChanges(): number {
    this.assertOpen();
    return this.engineState.totalChanges;
  }

  /**
   * Throw if {@link close} has already been called.
   * @internal
   * @throws {SqliteError} If the database is closed.
   */
  assertOpen(): void {
    if (this.closed) throw new SqliteError("Database is closed", "misuse");
  }

  private historyError(error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    throw new SqliteError(message, "misuse");
  }

  private captureLive(): Snapshot {
    return captureSnapshot(this.engineState, this.prng, this.now, this.seed, this.randomMode, this.systemClock);
  }

  private install(snapshot: Snapshot): void {
    this.durabilityObserver?.exposed();
    this.engineState.replaceWith(snapshot.state.cloneShallow(), { adopt: true });
    this.prng.setState(snapshot.prngState);
    if (!this.systemClock) this.now = fixedClock(new Date(snapshot.nowMs));
  }

  private prepareSingle(sql: string): Statement {
    const units = parseUnits(sql);
    if (units.length === 0) {
      throw new SqliteError("empty statement", "misuse");
    }
    if (units.length > 1) {
      throw new SqliteError("query()/prepare() accept a single statement only; use exec() for scripts", "misuse");
    }
    return Statement.create(
      this,
      sql,
      units.map((u) => u.statement),
      units.map((u) => u.sql),
    );
  }
}

const disposeKey = (Symbol as unknown as { dispose?: symbol }).dispose;
if (typeof disposeKey === "symbol") {
  Object.defineProperty(Database.prototype, disposeKey, {
    value: function (this: Database): void {
      this.close();
    },
    writable: true,
    configurable: true,
  });
}

function isAdopted(value: object): value is AdoptedDatabase {
  return ADOPT in value;
}

function project(point: Checkpoint<Snapshot>): HistoryCheckpoint {
  return { id: point.id, branch: point.branch, parent: point.parent, at: point.at };
}

/** @internal Used by {@link Snapshot.open}. */
export function createAdoptedDatabase(opts: Omit<AdoptedDatabase, typeof ADOPT>): Database {
  return new Database({
    [ADOPT]: true,
    ...opts,
  } as DatabaseOptions);
}

export { Snapshot } from "./snapshot.ts";
export type { DatabaseOptions };
