import { pgError } from "../errors/error.ts";
import { assert } from "../runtime/assert.ts";
import type { DatabaseState } from "../storage/database-state.ts";

interface Snapshot {
  state: DatabaseState;
  prngState: bigint;
}

/**
 * Single-session transaction manager with copy-on-write snapshots: BEGIN /
 * SAVEPOINT freeze shared catalog objects and capture a shallow clone; writes
 * copy-on-write via ensureWritableTable. ROLLBACK restores the snapshot.
 */
export class TransactionManager {
  private base: Snapshot | null = null;
  private savepoints: Array<{ name: string; snap: Snapshot }> = [];
  private freezeDepth = 0;

  constructor(private readonly state: DatabaseState) {}

  get inTransaction(): boolean {
    return this.base !== null;
  }

  private takeSnapshot(): Snapshot {
    this.state.freezeShared();
    this.freezeDepth++;
    return { state: this.state.cloneShallow(), prngState: this.state.prng.getState() };
  }

  private restore(snap: Snapshot): void {
    this.state.restoreFrom(snap.state);
    this.state.prng.setState(snap.prngState);
  }

  private thawOnce(): void {
    if (this.freezeDepth > 0) {
      this.state.thawShared();
      this.freezeDepth--;
    }
  }

  begin(): void {
    if (this.base !== null) {
      return;
    }
    this.base = this.takeSnapshot();
    this.state.inTransaction = true;
    assert(this.freezeDepth === 1, "BEGIN freeze depth");
  }

  commit(): void {
    this.base = null;
    this.savepoints = [];
    this.state.inTransaction = false;
    this.state.localSettings.clear();
    while (this.freezeDepth > 0) this.thawOnce();
  }

  rollback(): void {
    if (this.base !== null) {
      this.restore(this.base);
    }
    this.base = null;
    this.savepoints = [];
    this.state.inTransaction = false;
    this.state.localSettings.clear();
    while (this.freezeDepth > 0) this.thawOnce();
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
    this.freezeDepth = 0;
  }
}
