import { PostgresError } from "../errors/error.ts";
import {
  type Clock,
  type DatabaseOptions,
  DEFAULT_DATABASE_SEED,
  type Int8Mode,
  OsEntropy,
  Prng,
  type RandomMode,
  resolveClock,
} from "../runtime/index.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import { createAdoptedDatabase, type Database, requireCodec } from "./database.ts";

const bytesCache = new WeakMap<Uint8Array, Snapshot>();

interface SnapshotInit {
  state: DatabaseState;
  prngState: bigint;
  nowMs: number;
  seed: number | bigint;
  randomMode: RandomMode;
  systemClock: boolean;
  int8Mode: Int8Mode;
  bytes?: Uint8Array | null;
}

/**
 * Frozen in-memory database template. {@link open} is a copy-on-write fork.
 * Encoded PGMM bytes are produced lazily via {@link encode}.
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
  /** @internal */
  readonly int8Mode: Int8Mode;
  private cachedBytes: Uint8Array | null;

  /** @internal */
  constructor(init: SnapshotInit) {
    this.state = init.state;
    this.prngState = init.prngState;
    this.nowMs = init.nowMs;
    this.seed = init.seed;
    this.randomMode = init.randomMode;
    this.systemClock = init.systemClock;
    this.int8Mode = init.int8Mode;
    this.cachedBytes = init.bytes ?? null;
  }

  /** Encoded PGMM blob. Computed once; never mutates a buffer passed to {@link decode}. */
  encode(): Uint8Array {
    if (this.cachedBytes) return this.cachedBytes;
    const { encodeDatabaseState } = requireCodec();
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
    const { decodeDatabaseState } = requireCodec();
    const prng = new Prng(DEFAULT_DATABASE_SEED);
    const decoded = decodeDatabaseState(bytes, prng, () => new Date(0));
    decoded.state.freezeShared();
    const runtime = decoded.runtime;
    if (!runtime) {
      throw new PostgresError("snapshot_format", "invalid or truncated postgres-mem snapshot", "XX000");
    }
    const snap = new Snapshot({
      state: decoded.state,
      prngState: runtime.prngState,
      nowMs: runtime.nowMs,
      seed: DEFAULT_DATABASE_SEED,
      randomMode: "deterministic",
      systemClock: false,
      int8Mode: "bigint",
      bytes,
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
  int8Mode: Int8Mode,
): Snapshot {
  state.freezeShared();
  return new Snapshot({
    state: state.cloneShallow(),
    prngState: prng.getState(),
    nowMs: now().getTime(),
    seed,
    randomMode,
    systemClock,
    int8Mode,
  });
}

/** @internal */
export function openSnapshot(snapshot: Snapshot, options: DatabaseOptions = {}): Database {
  const seed = options.seed ?? snapshot.seed;
  const randomMode = options.random ?? snapshot.randomMode;
  const systemClock = options.now === "system" || (options.now === undefined && snapshot.systemClock);
  const int8Mode = options.int8 ?? snapshot.int8Mode;
  const prng = randomMode === "os" ? new OsEntropy() : new Prng(seed);
  if (randomMode !== "os") prng.setState(snapshot.prngState);
  let now = resolveClock(systemClock ? "system" : options.now);
  if (!systemClock) {
    const ms = snapshot.nowMs;
    now = () => new Date(ms);
  }
  const state = snapshot.state.cloneShallow();
  state.prng = prng;
  state.clock = now;
  return createAdoptedDatabase({
    state,
    prng,
    now,
    seed,
    randomMode,
    systemClock,
    int8Mode,
  });
}
