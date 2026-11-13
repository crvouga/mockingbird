import { flushDeferredForeignKeys } from "../constraints/enforce.ts";
import { pgError } from "../errors/error.ts";
import { endTransactionCursors } from "../executor/cursors.ts";
import { flushConstraintTriggers } from "../executor/triggers.ts";
import { assert } from "../runtime/assert.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import { TRANSACTION_GUCS } from "../storage/guc-catalog.ts";

interface Snapshot {
  state: DatabaseState;
  prngState: bigint;
  /** the copy-on-write hold this snapshot keeps on the live state ({@link DatabaseState.holdForRollback}) */
  epoch: number;
}

/**
 * Single-session transaction manager with copy-on-write snapshots: BEGIN / SAVEPOINT take an O(1)
 * hold on the live catalog and keep a forked view of it; writes copy-on-write via
 * `ensureWritable*`. ROLLBACK restores the snapshot. Holds are released at COMMIT / ROLLBACK.
 */
export class TransactionManager {
  private base: Snapshot | null = null;
  private savepoints: Array<{ name: string; snap: Snapshot }> = [];
  /** every hold taken in this transaction (BEGIN and each SAVEPOINT), released when it ends */
  private holds: number[] = [];
  /**
   * Whether a statement of this transaction has read or written data yet (PostgreSQL's
   * FirstSnapshotSet): after that, the transaction's isolation level and read-write mode are fixed.
   */
  snapshotTaken = false;

  constructor(private readonly state: DatabaseState) {}

  get inTransaction(): boolean {
    return this.base !== null;
  }

  /** Inside a SAVEPOINT. */
  get inSubtransaction(): boolean {
    return this.savepoints.length > 0;
  }

  private takeSnapshot(): Snapshot {
    const prngState = this.state.prng.getState();
    const { state, epoch } = this.state.holdForRollback();
    this.holds.push(epoch);
    return { state, prngState, epoch };
  }

  private restore(snap: Snapshot): void {
    // A savepoint may be restored repeatedly. Keep its catalog maps independent
    // when the live branch replaces a table after the first ROLLBACK TO.
    // The snapshot's hold is still alive here, so its objects stay copy-on-write.
    const custom = [...this.state.settings.keys()].filter((name) => name.includes("."));
    this.state.restoreFrom(snap.state.cloneShallow(), true);
    this.state.prng.setState(snap.prngState);
    // a custom parameter defined in the rolled-back work stays defined, as an empty placeholder
    for (const name of custom) if (!this.state.settings.has(name)) this.state.settings.set(name, "");
  }

  private releaseHolds(): void {
    for (const epoch of this.holds) this.state.releaseHold(epoch);
    this.holds = [];
  }

  begin(): void {
    if (this.base !== null) {
      return;
    }
    this.base = this.takeSnapshot();
    this.state.inTransaction = true;
    this.snapshotTaken = false;
    // the transaction's own characteristics start from the session's defaults
    for (const [name, sessionDefault] of TRANSACTION_GUCS) {
      const value = this.state.getSetting(sessionDefault);
      if (value !== undefined) this.state.localSettings.set(name, value);
    }
    assert(this.holds.length === 1, "BEGIN holds one snapshot");
  }

  commit(): void {
    try {
      flushConstraintTriggers(this.state, true);
      flushDeferredForeignKeys(this.state, true);
    } catch (error) {
      this.rollback();
      throw error;
    }
    this.base = null;
    this.savepoints = [];
    this.state.inTransaction = false;
    this.snapshotTaken = false;
    this.state.transactionXid = null;
    this.state.localSettings.clear();
    this.state.pendingTriggers = [];
    this.state.pendingForeignKeys = [];
    this.state.constraintModes.clear();
    endTransactionCursors(this.state, true);
    this.releaseHolds();
  }

  rollback(): void {
    if (this.base !== null) {
      this.restore(this.base);
    }
    this.base = null;
    this.savepoints = [];
    this.state.inTransaction = false;
    this.snapshotTaken = false;
    this.state.transactionXid = null;
    this.state.localSettings.clear();
    this.state.pendingTriggers = [];
    this.state.pendingForeignKeys = [];
    this.state.constraintModes.clear();
    endTransactionCursors(this.state, false);
    this.releaseHolds();
  }

  savepoint(name: string): void {
    if (this.base === null) {
      throw pgError("transaction_state", "SAVEPOINT can only be used in transaction blocks", "25P01");
    }
    this.savepoints.push({ name, snap: this.takeSnapshot() });
  }

  releaseSavepoint(name: string): void {
    const idx = this.findSavepoint(name);
    this.savepoints.splice(idx);
  }

  rollbackToSavepoint(name: string): void {
    const idx = this.findSavepoint(name);
    const sp = this.savepoints[idx]!;
    this.restore(sp.snap);
    this.savepoints.splice(idx + 1);
  }

  private findSavepoint(name: string): number {
    if (this.base === null) {
      throw pgError("transaction_state", `SAVEPOINT can only be used in transaction blocks`, "25P01");
    }
    for (let i = this.savepoints.length - 1; i >= 0; i--) {
      if (this.savepoints[i]!.name === name) return i;
    }
    throw pgError("invalid_savepoint_specification", `savepoint "${name}" does not exist`, "3B001");
  }

  reset(): void {
    this.base = null;
    this.savepoints = [];
    this.state.inTransaction = false;
    this.state.transactionXid = null;
    this.releaseHolds();
  }
}
