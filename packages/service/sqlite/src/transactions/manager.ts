import { SqliteError } from "../errors/index.ts";
import type { Prng } from "../runtime/prng.ts";
import type { DatabaseState } from "../storage/database-state.ts";

interface SavepointSnapshot {
  name: string;
  state: DatabaseState;
  prngState: bigint;
}

export class TransactionManager {
  readonly state: DatabaseState;
  readonly prng: Prng;
  private transactionSnapshot: DatabaseState | null = null;
  private transactionPrngState: bigint | null = null;
  private savepoints: SavepointSnapshot[] = [];
  private startedBySavepoint = false;

  constructor(state: DatabaseState, prng: Prng) {
    this.state = state;
    this.prng = prng;
  }

  get inTransaction(): boolean {
    return this.transactionSnapshot !== null;
  }

  begin(): void {
    if (this.inTransaction) {
      throw new SqliteError("cannot start a transaction within a transaction", "transaction", "SQLITE_ERROR");
    }
    this.state.freezeShared();
    this.transactionSnapshot = this.state.cloneShallow();
    this.transactionPrngState = this.prng.getState();
    this.savepoints = [];
    this.startedBySavepoint = false;
  }

  commit(): void {
    this.requireTransaction("cannot commit - no transaction is active");
    this.transactionSnapshot = null;
    this.transactionPrngState = null;
    this.savepoints = [];
    this.startedBySavepoint = false;
    this.state.thawShared();
  }

  rollback(savepoint?: string): void {
    this.requireTransaction("cannot rollback - no transaction is active");
    // SQLite keeps total_changes / last_insert_rowid / changes across ROLLBACK
    // (and ROLLBACK TO); only row/schema state is restored.
    const preserved = {
      totalChanges: this.state.totalChanges,
      changes: this.state.changes,
      lastInsertRowid: this.state.lastInsertRowid,
    };
    if (savepoint !== undefined) {
      const index = this.findSavepoint(savepoint);
      const snapshot = this.savepoints[index];
      if (!snapshot) throw new SqliteError(`no such savepoint: ${savepoint}`, "transaction", "SQLITE_ERROR");
      // Clone — adopting would alias live state with the savepoint snapshot Map.
      this.state.replaceWith(snapshot.state);
      this.prng.setState(snapshot.prngState);
      this.state.totalChanges = preserved.totalChanges;
      this.state.changes = preserved.changes;
      this.state.lastInsertRowid = preserved.lastInsertRowid;
      this.savepoints.splice(index + 1);
      return;
    }

    const snapshot = this.transactionSnapshot;
    const prngState = this.transactionPrngState;
    if (!snapshot || prngState === null) {
      throw new SqliteError("cannot rollback - no transaction is active", "transaction", "SQLITE_ERROR");
    }
    this.state.replaceWith(snapshot, { adopt: true });
    this.prng.setState(prngState);
    this.state.totalChanges = preserved.totalChanges;
    this.state.changes = preserved.changes;
    this.state.lastInsertRowid = preserved.lastInsertRowid;
    this.transactionSnapshot = null;
    this.transactionPrngState = null;
    this.savepoints = [];
    this.startedBySavepoint = false;
    this.state.thawShared();
  }

  savepoint(name: string): void {
    if (!this.inTransaction) {
      this.state.freezeShared();
      this.transactionSnapshot = this.state.cloneShallow();
      this.transactionPrngState = this.prng.getState();
      this.startedBySavepoint = true;
    } else {
      this.state.freezeShared();
    }
    this.savepoints.push({
      name,
      state: this.state.cloneShallow(),
      prngState: this.prng.getState(),
    });
  }

  release(name: string): void {
    this.requireTransaction("cannot release savepoint - no transaction is active");
    const index = this.findSavepoint(name);
    this.savepoints.splice(index);
    if (this.startedBySavepoint && this.savepoints.length === 0) {
      this.transactionSnapshot = null;
      this.transactionPrngState = null;
      this.startedBySavepoint = false;
      this.state.thawShared();
    }
  }

  private findSavepoint(name: string): number {
    const normalized = name.toLowerCase();
    for (let index = this.savepoints.length - 1; index >= 0; index--) {
      const savepoint = this.savepoints[index];
      if (savepoint && savepoint.name.toLowerCase() === normalized) return index;
    }
    throw new SqliteError(`no such savepoint: ${name}`, "transaction", "SQLITE_ERROR");
  }

  private requireTransaction(message: string): void {
    if (!this.inTransaction) throw new SqliteError(message, "transaction", "SQLITE_ERROR");
  }
}
