/**
 * Deterministic 64-bit PRNG (xorshift64*).
 * Used for PostgreSQL `random()` / `gen_random_uuid()` and any other
 * nondeterministic builtins.
 */
export class Prng {
  private state: bigint;

  /**
   * @param seed - Engine seed. `0` is replaced with a non-zero constant.
   */
  constructor(seed: number | bigint = 1) {
    let s = typeof seed === "bigint" ? seed : BigInt(seed | 0);
    if (s === 0n) s = 0x9e3779b97f4a7c15n;
    this.state = BigInt.asUintN(64, s);
  }

  /** Next unsigned 64-bit value. */
  nextU64(): bigint {
    let x = this.state;
    x ^= BigInt.asUintN(64, x >> 12n);
    x ^= BigInt.asUintN(64, x << 25n);
    x ^= BigInt.asUintN(64, x >> 27n);
    this.state = BigInt.asUintN(64, x);
    return BigInt.asUintN(64, x * 0x2545f4914f6cdd1dn);
  }

  /** Next float in `[0, 1)` from 53 bits of {@link nextU64}. */
  nextFloat(): number {
    const bits = this.nextU64();
    return Number(bits >> 11n) / Number(1n << 53n);
  }

  /**
   * Next integer in `[min, max]` (inclusive).
   *
   * @throws {RangeError} If `max < min`.
   */
  nextInt(min: number, max: number): number {
    if (max < min) throw new RangeError("max < min");
    const span = max - min + 1;
    return min + Number(this.nextU64() % BigInt(span));
  }

  /** Next bigint in `[min, max]` (inclusive). */
  nextBigInt(min: bigint, max: bigint): bigint {
    if (max < min) throw new RangeError("max < min");
    const span = max - min + 1n;
    return min + (this.nextU64() % span);
  }

  /** Random UUIDv4 string from PRNG bits. */
  nextUuid4(): string {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i += 8) {
      let v = this.nextU64();
      for (let j = 0; j < 8; j++) {
        bytes[i + j] = Number(v & 0xffn);
        v >>= 8n;
      }
    }
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /** Reseed from a float in [-1, 1] (SQL `setseed()`). */
  setSeedFloat(seed: number): void {
    const scaled = BigInt(Math.round(seed * 2 ** 31));
    let s = BigInt.asUintN(64, scaled * 0x9e3779b97f4a7c15n);
    if (s === 0n) s = 0x9e3779b97f4a7c15n;
    this.state = s;
  }

  /** Current unsigned 64-bit engine state (for snapshot / transaction rollback). */
  getState(): bigint {
    return this.state;
  }

  /** Restore unsigned 64-bit engine state from {@link getState}. */
  setState(state: bigint): void {
    this.state = BigInt.asUintN(64, state);
  }

  /** Independent copy with the same engine state. */
  clone(): Prng {
    const copy = new Prng(1);
    copy.state = this.state;
    return copy;
  }
}

/**
 * CSPRNG-backed entropy for `random()` / `gen_random_uuid()` when
 * {@link DatabaseOptions.random} is `"os"`. `setState` is a no-op so
 * ROLLBACK / snapshot restore do not rewind draws.
 */
export class OsEntropy extends Prng {
  constructor() {
    super(1);
  }

  override nextU64(): bigint {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let value = 0n;
    for (let i = 0; i < 8; i++) {
      value |= BigInt(bytes[i]!) << BigInt(i * 8);
    }
    return BigInt.asUintN(64, value);
  }

  override getState(): bigint {
    return 0n;
  }

  override setState(_state: bigint): void {}

  override clone(): Prng {
    return new OsEntropy();
  }
}

/** FNV-1a hash of `parts` as a signed 32-bit seed (for tests and custom PRNGs). */
export function deriveSeed(...parts: Array<number | string | bigint>): number {
  let hash = 2166136261;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i)!;
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash | 0;
}
