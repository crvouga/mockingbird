import { pgError } from "../errors/error.ts";
import { formatNetwork, type NetworkValue, networkParts } from "./network.ts";

/**
 * The `inet` / `cidr` operators and the functions built on the same bit arithmetic
 * (https://www.postgresql.org/docs/18/functions-net.html). Operands are canonical datum texts.
 */

/** bitncmp: compare the first `bits` bits of two addresses. */
function prefixCompare(a: Uint8Array, b: Uint8Array, bits: number): number {
  for (let i = 0; i < a.length && bits > 0; i++, bits -= 8) {
    const kept = Math.min(8, bits);
    const mask = (0xff << (8 - kept)) & 0xff;
    const diff = (a[i]! & mask) - (b[i]! & mask);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

const sameFamily = (a: NetworkValue, b: NetworkValue): boolean => a.bytes.length === b.bytes.length;

/** `<<` (strict) / `<<=`: a's network lies within b's. */
export function networkSubnetOf(a: string, b: string, orEqual: boolean): boolean {
  const x = networkParts(a);
  const y = networkParts(b);
  if (!sameFamily(x, y)) return false;
  if (orEqual ? x.bits < y.bits : x.bits <= y.bits) return false;
  return prefixCompare(x.bytes, y.bytes, y.bits) === 0;
}

/** `&&`: either network contains the other. */
export function networkOverlaps(a: string, b: string): boolean {
  const x = networkParts(a);
  const y = networkParts(b);
  return sameFamily(x, y) && prefixCompare(x.bytes, y.bytes, Math.min(x.bits, y.bits)) === 0;
}

const toBig = (bytes: Uint8Array): bigint => bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);

function fromBig(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

/** `~inet` */
export function networkNot(a: string): string {
  const x = networkParts(a);
  return formatNetwork("inet", { bytes: x.bytes.map((byte) => ~byte & 0xff), bits: x.bits });
}

/** `inet & inet` / `inet | inet` */
export function networkBitwise(op: "&" | "|", a: string, b: string): string {
  const x = networkParts(a);
  const y = networkParts(b);
  if (!sameFamily(x, y)) {
    throw pgError(
      "invalid_parameter_value",
      `cannot ${op === "&" ? "AND" : "OR"} inet values of different sizes`,
      "22023",
    );
  }
  const bytes = x.bytes.map((byte, i) => (op === "&" ? byte & y.bytes[i]! : byte | y.bytes[i]!));
  return formatNetwork("inet", { bytes, bits: Math.max(x.bits, y.bits) });
}

/** `inet + int8` / `inet - int8`: address arithmetic that keeps the mask length. */
export function networkAdd(a: string, delta: bigint): string {
  const x = networkParts(a);
  const sum = toBig(x.bytes) + delta;
  if (sum < 0n || sum >= 1n << BigInt(x.bytes.length * 8)) {
    throw pgError("numeric_value_out_of_range", "result is out of range", "22003");
  }
  return formatNetwork("inet", { bytes: fromBig(sum, x.bytes.length), bits: x.bits });
}

/** `inet - inet` */
export function networkDiff(a: string, b: string): bigint {
  const x = networkParts(a);
  const y = networkParts(b);
  if (!sameFamily(x, y)) {
    throw pgError("invalid_parameter_value", "cannot subtract inet values of different sizes", "22023");
  }
  const diff = toBig(x.bytes) - toBig(y.bytes);
  if (diff < -(1n << 63n) || diff >= 1n << 63n) {
    throw pgError("numeric_value_out_of_range", "result is out of range", "22003");
  }
  return diff;
}

export function networkSameFamily(a: string, b: string): boolean {
  return sameFamily(networkParts(a), networkParts(b));
}

const masked = (bytes: Uint8Array, bits: number): Uint8Array =>
  bytes.map((byte, i) => {
    const kept = Math.max(0, Math.min(8, bits - i * 8));
    return byte & ((0xff << (8 - kept)) & 0xff);
  });

/** `inet_merge`: the smallest network that includes both. */
export function networkMerge(a: string, b: string): string {
  const x = networkParts(a);
  const y = networkParts(b);
  if (!sameFamily(x, y)) {
    throw pgError("invalid_parameter_value", "cannot merge addresses from different families", "22023");
  }
  let bits = Math.min(x.bits, y.bits);
  while (bits > 0 && prefixCompare(x.bytes, y.bytes, bits) !== 0) bits--;
  return formatNetwork("cidr", { bytes: masked(x.bytes, bits), bits });
}

/** `set_masklen(inet|cidr, int)`: -1 means the full address width; a cidr drops the host bits. */
export function networkSetMasklen(type: "inet" | "cidr", a: string, bits: number): string {
  const x = networkParts(a);
  const max = x.bytes.length * 8;
  const target = bits === -1 ? max : bits;
  if (target < 0 || target > max) {
    throw pgError("invalid_parameter_value", `invalid mask length: ${bits}`, "22023");
  }
  return formatNetwork(type, { bytes: type === "cidr" ? masked(x.bytes, target) : x.bytes, bits: target });
}

/** `hostmask(inet)`: the host bits of the mask set. */
export function networkHostmask(a: string): string {
  const x = networkParts(a);
  const ones = new Uint8Array(x.bytes.length).fill(0xff);
  const net = masked(ones, x.bits);
  return formatNetwork("inet", { bytes: ones.map((byte, i) => byte & ~net[i]! & 0xff), bits: x.bytes.length * 8 });
}
