import {
  type Clock,
  type DatabaseOptions,
  DEFAULT_DATABASE_SEED,
  DEFAULT_NOW,
  fixedClock,
  OsEntropy,
  Prng,
  type RandomMode,
  resolveClock,
} from "../runtime/index.ts";
import { decodeDatabaseState, encodeDatabaseState } from "../serialization/codec.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import { createAdoptedDatabase, type Database } from "./database.ts";

const bytesCache = new WeakMap<Uint8Array, Snapshot>();

interface SnapshotInit {
  state: DatabaseState;
  prngState: bigint;
  nowMs: number;
  seed: number | bigint;
  randomMode: RandomMode;
  systemClock: boolean;
  bytes?: Uint8Array | null;
  runtimePresent: boolean;
}

/**
 * Frozen in-memory database template. {@link open} is a copy-on-write fork.
 * Encoded SQLM bytes are produced lazily via {@link encode}.
 */
export class Snapshot {
  /** @internal */
  readonly state: DatabaseState;
  /** @internal */
  readonly prngState: bigint;
  /** @internal */
  readonly nowMs: number;
  /** @internal */
  readonly seed: number | bigint;
  /** @internal */
  readonly randomMode: RandomMode;
  /** @internal */
  readonly systemClock: boolean;
  /** @internal true when the blob (or live capture) included PRNG/clock. */
  readonly runtimePresent: boolean;
  private cachedBytes: Uint8Array | null;

  /** @internal */
  constructor(init: SnapshotInit) {
    this.state = init.state;
    this.prngState = init.prngState;
    this.nowMs = init.nowMs;
    this.seed = init.seed;
    this.randomMode = init.randomMode;
    this.systemClock = init.systemClock;
    this.runtimePresent = init.runtimePresent;
    this.cachedBytes = init.bytes ?? null;
  }

  /** Encoded SQLM blob. Computed once; never mutates a buffer passed to {@link decode}. */
  encode(): Uint8Array {
    if (this.cachedBytes) return this.cachedBytes;
    this.cachedBytes = encodeDatabaseState(this.state, {
      prngState: this.prngState,
      nowMs: this.nowMs,
    });
    return this.cachedBytes;
  }

  /**
   * Copy-on-write database from this frozen template. Does not re-encode or re-decode.
   */
  open(options: DatabaseOptions = {}): Database {
    return openSnapshot(this, options);
  }

  /**
   * Decode `bytes` once and freeze the result. The same `Uint8Array` object
   * returns the same {@link Snapshot} (WeakMap), so later {@link open} calls
   * are copy-on-write forks after the first hydrate.
   */
  static decode(bytes: Uint8Array): Snapshot {
    const hit = bytesCache.get(bytes);
    if (hit) return hit;
    const decoded = decodeDatabaseState(bytes);
    decoded.state.freezeShared();
    const snap = new Snapshot({
      state: decoded.state,
      prngState: decoded.runtime?.prngState ?? 0n,
      nowMs: decoded.runtime?.nowMs ?? DEFAULT_NOW.getTime(),
      seed: DEFAULT_DATABASE_SEED,
      randomMode: "deterministic",
      systemClock: false,
      bytes,
      runtimePresent: decoded.runtime !== null,
    });
    bytesCache.set(bytes, snap);
    return snap;
  }
}

/** @internal Capture live engine state without encoding. */
export function captureSnapshot(
  state: DatabaseState,
  prng: Prng,
  now: Clock,
  seed: number | bigint,
  randomMode: RandomMode,
  systemClock: boolean,
): Snapshot {
  state.freezeShared();
  return new Snapshot({
    state: state.cloneShallow(),
    prngState: prng.getState(),
    nowMs: now().getTime(),
    seed,
    randomMode,
    systemClock,
    runtimePresent: true,
  });
}

/** @internal */
export function openSnapshot(snapshot: Snapshot, options: DatabaseOptions = {}): Database {
  const seed = options.seed ?? snapshot.seed;
  const randomMode = options.random ?? snapshot.randomMode;
  const systemClock = options.now === "system" || (options.now === undefined && snapshot.systemClock);
  const prng = randomMode === "os" ? new OsEntropy() : new Prng(seed);
  if (snapshot.runtimePresent && randomMode !== "os") prng.setState(snapshot.prngState);
  let now = resolveClock(systemClock ? "system" : options.now);
  if (snapshot.runtimePresent && !systemClock) now = fixedClock(new Date(snapshot.nowMs));
  return createAdoptedDatabase({
    state: snapshot.state.cloneShallow(),
    prng,
    now,
    seed,
    randomMode,
    systemClock,
  });
}
