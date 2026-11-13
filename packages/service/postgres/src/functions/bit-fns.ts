import { pgError } from "../errors/error.ts";
import { castTo } from "../types/cast.ts";
import { type TypedValue, type TypeId, tv, typeDisplayName } from "../types/value.ts";
import { substrImpl } from "./string-fns.ts";
import { argBigInt, argInt, type ScalarFn, strict } from "./util.ts";

/**
 * bit / bit varying overloads of the string builtins (substring, overlay, position, octet_length)
 * plus get_bit / set_bit / bit_count for bit and bytea. A bit datum is its string of '0'/'1'.
 */

const isBit = (t: TypeId): boolean => t === "bit" || t === "varbit";

function bitArg(ctx: Parameters<ScalarFn>[0], v: TypedValue): string {
  return castTo(ctx, v, "varbit").v as string;
}

function noSuchFunction(name: string, args: TypedValue[]): never {
  const sig = args.map((a) => typeDisplayName(a.t)).join(", ");
  throw pgError("undefined_function", `function ${name}(${sig}) does not exist`, "42883");
}

/** Dispatch to `bitFn` when the first argument is a bit string, else to the registered function. */
function overload(registry: Map<string, ScalarFn>, name: string, bitFn: ScalarFn): void {
  const base = registry.get(name);
  registry.set(name, (ctx, args) => {
    if (args[0] !== undefined && isBit(args[0].t)) return bitFn(ctx, args);
    if (!base) noSuchFunction(name, args);
    return base(ctx, args);
  });
}

function bitIndexError(n: number | bigint, len: number): never {
  throw pgError("array_subscript_error", `bit index ${n} out of valid range (0..${len - 1})`, "2202E");
}

function byteaIndexError(n: bigint, bytes: number): never {
  throw pgError("array_subscript_error", `index ${n} out of valid range, 0..${bytes * 8 - 1}`, "2202E");
}

function newBit(ctx: Parameters<ScalarFn>[0], v: TypedValue): number {
  const b = argInt(ctx, v);
  if (b !== 0 && b !== 1) throw pgError("invalid_parameter_value", "new bit must be 0 or 1", "22023");
  return b;
}

function popcount(bytes: Uint8Array): bigint {
  let n = 0;
  for (let b of bytes) {
    while (b) {
      n += b & 1;
      b >>= 1;
    }
  }
  return BigInt(n);
}

export function overloadBitStringFunctions(registry: Map<string, ScalarFn>): void {
  // substr has no bit overload in PostgreSQL; only substring does
  overload(registry, "substr", (_ctx, args) => noSuchFunction("substr", args));
  overload(
    registry,
    "substring",
    strict("bit", (ctx, args) => {
      const s = bitArg(ctx, args[0]!);
      const start = argInt(ctx, args[1]!);
      const len = args.length > 2 ? argInt(ctx, args[2]!) : undefined;
      return tv("bit", substrImpl(s, start, len));
    }),
  );
  overload(
    registry,
    "octet_length",
    strict("int4", (ctx, args) => tv("int4", Math.ceil(bitArg(ctx, args[0]!).length / 8))),
  );
  overload(
    registry,
    "position",
    strict("int4", (ctx, args) => {
      const needle = bitArg(ctx, args[0]!);
      const hay = bitArg(ctx, args[1]!);
      return tv("int4", hay.indexOf(needle) + 1);
    }),
  );
  overload(
    registry,
    "overlay",
    strict("bit", (ctx, args) => {
      const s = bitArg(ctx, args[0]!);
      const placing = bitArg(ctx, args[1]!);
      const from = argInt(ctx, args[2]!);
      const forLen = args.length > 3 ? argInt(ctx, args[3]!) : placing.length;
      // bitoverlay: substring(s, 1, from - 1) || placing || substring(s, from + for)
      const before = substrImpl(s, 1, from - 1);
      const after = substrImpl(s, from + forLen);
      return tv("bit", before + placing + after);
    }),
  );

  registry.set(
    "get_bit",
    strict("int4", (ctx, args) => {
      const a = args[0]!;
      if (isBit(a.t)) {
        const s = a.v as string;
        const n = argInt(ctx, args[1]!);
        if (n < 0 || n >= s.length) bitIndexError(n, s.length);
        return tv("int4", s[n] === "1" ? 1 : 0);
      }
      if (a.t !== "bytea") noSuchFunction("get_bit", args);
      const bytes = a.v as Uint8Array;
      const n = argBigInt(ctx, args[1]!);
      if (n < 0n || n >= BigInt(bytes.length * 8)) byteaIndexError(n, bytes.length);
      const i = Number(n);
      return tv("int4", (bytes[i >> 3]! >> (i & 7)) & 1);
    }),
  );
  registry.set("set_bit", (ctx, args) => {
    const a = args[0]!;
    if (!isBit(a.t) && a.t !== "bytea") noSuchFunction("set_bit", args);
    const resultType = a.t === "bytea" ? "bytea" : "bit";
    if (args.some((x) => x.v === null)) return tv(resultType, null);
    if (isBit(a.t)) {
      const s = a.v as string;
      const n = argInt(ctx, args[1]!);
      if (n < 0 || n >= s.length) bitIndexError(n, s.length);
      const b = newBit(ctx, args[2]!);
      return tv("bit", s.slice(0, n) + String(b) + s.slice(n + 1));
    }
    const bytes = new Uint8Array(a.v as Uint8Array);
    const n = argBigInt(ctx, args[1]!);
    if (n < 0n || n >= BigInt(bytes.length * 8)) byteaIndexError(n, bytes.length);
    const b = newBit(ctx, args[2]!);
    const i = Number(n);
    bytes[i >> 3] = b ? bytes[i >> 3]! | (1 << (i & 7)) : bytes[i >> 3]! & ~(1 << (i & 7));
    return tv("bytea", bytes);
  });
  registry.set(
    "bit_count",
    strict("int8", (_ctx, args) => {
      const a = args[0]!;
      if (isBit(a.t)) return tv("int8", BigInt((a.v as string).replaceAll("0", "").length));
      if (a.t !== "bytea") noSuchFunction("bit_count", args);
      return tv("int8", popcount(a.v as Uint8Array));
    }),
  );
}
