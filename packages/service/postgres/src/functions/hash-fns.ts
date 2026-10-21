import { castTo } from "../types/cast.ts";
import { tv } from "../types/value.ts";
import { digestBytes } from "./pgcrypto.ts";
import type { ScalarFn } from "./util.ts";
import { argBigInt, argText, strict } from "./util.ts";

/**
 * `sha224` .. `sha512(bytea)`, plus `hashtext(text)` and `hashtextextended(text, bigint)`: PostgreSQL's
 * `hash_any` / `hash_any_extended` (src/common/hashfn.c, Bob Jenkins' lookup3) over the UTF-8 bytes of
 * the string, so a key hashed here is the key a real server computes (advisory-lock keys, sharding).
 */

const utf8 = new TextEncoder();

const rot = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/** lookup3 `mix`, on unsigned 32-bit lanes held in `s` as [a, b, c]. */
function mix(s: Uint32Array): void {
  s[0] = (s[0]! - s[2]!) >>> 0;
  s[0] = (s[0]! ^ rot(s[2]!, 4)) >>> 0;
  s[2] = (s[2]! + s[1]!) >>> 0;
  s[1] = (s[1]! - s[0]!) >>> 0;
  s[1] = (s[1]! ^ rot(s[0]!, 6)) >>> 0;
  s[0] = (s[0]! + s[2]!) >>> 0;
  s[2] = (s[2]! - s[1]!) >>> 0;
  s[2] = (s[2]! ^ rot(s[1]!, 8)) >>> 0;
  s[1] = (s[1]! + s[0]!) >>> 0;
  s[0] = (s[0]! - s[2]!) >>> 0;
  s[0] = (s[0]! ^ rot(s[2]!, 16)) >>> 0;
  s[2] = (s[2]! + s[1]!) >>> 0;
  s[1] = (s[1]! - s[0]!) >>> 0;
  s[1] = (s[1]! ^ rot(s[0]!, 19)) >>> 0;
  s[0] = (s[0]! + s[2]!) >>> 0;
  s[2] = (s[2]! - s[1]!) >>> 0;
  s[2] = (s[2]! ^ rot(s[1]!, 4)) >>> 0;
  s[1] = (s[1]! + s[0]!) >>> 0;
}

/** lookup3 `final`. */
function finalMix(s: Uint32Array): void {
  s[2] = (s[2]! ^ s[1]!) >>> 0;
  s[2] = (s[2]! - rot(s[1]!, 14)) >>> 0;
  s[0] = (s[0]! ^ s[2]!) >>> 0;
  s[0] = (s[0]! - rot(s[2]!, 11)) >>> 0;
  s[1] = (s[1]! ^ s[0]!) >>> 0;
  s[1] = (s[1]! - rot(s[0]!, 25)) >>> 0;
  s[2] = (s[2]! ^ s[1]!) >>> 0;
  s[2] = (s[2]! - rot(s[1]!, 16)) >>> 0;
  s[0] = (s[0]! ^ s[2]!) >>> 0;
  s[0] = (s[0]! - rot(s[2]!, 4)) >>> 0;
  s[1] = (s[1]! ^ s[0]!) >>> 0;
  s[1] = (s[1]! - rot(s[0]!, 14)) >>> 0;
  s[2] = (s[2]! ^ s[1]!) >>> 0;
  s[2] = (s[2]! - rot(s[1]!, 24)) >>> 0;
}

const word = (k: Uint8Array, at: number): number =>
  (k[at]! | (k[at + 1]! << 8) | (k[at + 2]! << 16) | (k[at + 3]! << 24)) >>> 0;

/** `hash_any_extended`; `seed` 0 is `hash_any` (whose result is `c`, the low half). */
function hashAny(k: Uint8Array, seed: bigint): { b: number; c: number } {
  const s = new Uint32Array(3);
  s.fill((0x9e3779b9 + k.length + 3923095) >>> 0);
  if (seed !== 0n) {
    const bits = BigInt.asUintN(64, seed);
    s[0] = (s[0]! + Number(bits >> 32n)) >>> 0;
    s[1] = (s[1]! + Number(bits & 0xffffffffn)) >>> 0;
    mix(s);
  }
  let at = 0;
  let len = k.length;
  for (; len >= 12; at += 12, len -= 12) {
    s[0] = (s[0]! + word(k, at)) >>> 0;
    s[1] = (s[1]! + word(k, at + 4)) >>> 0;
    s[2] = (s[2]! + word(k, at + 8)) >>> 0;
    mix(s);
  }
  // the tail: c's lowest byte is reserved for the length, so its bytes start at bit 8
  for (let i = len - 1; i >= 0; i--) {
    const byte = k[at + i]!;
    if (i >= 8) s[2] = (s[2]! + (byte << (8 * (i - 7)))) >>> 0;
    else if (i >= 4) s[1] = (s[1]! + (byte << (8 * (i - 4)))) >>> 0;
    else s[0] = (s[0]! + (byte << (8 * i))) >>> 0;
  }
  finalMix(s);
  return { b: s[1]!, c: s[2]! };
}

export function hashText(text: string): number {
  return hashAny(utf8.encode(text), 0n).c | 0;
}

export function hashTextExtended(text: string, seed: bigint): bigint {
  const { b, c } = hashAny(utf8.encode(text), seed);
  return BigInt.asIntN(64, (BigInt(b) << 32n) | BigInt(c));
}

export function getHashFunctions(): Map<string, ScalarFn> {
  const m = new Map<string, ScalarFn>();
  m.set(
    "hashtext",
    strict("int4", (ctx, args) => tv("int4", hashText(argText(ctx, args[0]!)))),
  );
  m.set(
    "hashtextextended",
    strict("int8", (ctx, args) => tv("int8", hashTextExtended(argText(ctx, args[0]!), argBigInt(ctx, args[1]!)))),
  );
  // the core SHA-2 family (PostgreSQL 11+), unlike pgcrypto's digest() needing no extension
  for (const name of ["sha224", "sha256", "sha384", "sha512"]) {
    m.set(
      name,
      strict("bytea", (ctx, args) => {
        const bytes = castTo(ctx, args[0]!, "bytea", { explicit: true }).v as Uint8Array;
        return tv("bytea", digestBytes(bytes, name));
      }),
    );
  }
  return m;
}
