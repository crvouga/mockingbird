import type { TypeMod } from "../types/value.ts";

const VARHDRSZ = 4;
/** `INTERVAL_FULL_RANGE`: an interval with a precision and no field restriction. */
const INTERVAL_FULL_RANGE = 0x7fff;

/**
 * The `atttypmod` a `RowDescription` field reports for a type with a modifier: the length plus the
 * 4-byte header for `varchar(n)` / `char(n)`, `(precision << 16 | scale) + 4` for `numeric(p,s)`, the
 * fractional-second precision of `time` / `timestamp`, and -1 for everything without one.
 */
export function wireTypeModifier(type: string, mod: TypeMod | null | undefined): number {
  if (!mod || mod.a === undefined) return -1;
  switch (type) {
    case "varchar":
    case "bpchar":
      return mod.a + VARHDRSZ;
    case "numeric":
      return ((mod.a << 16) | ((mod.b ?? 0) & 0x7ff)) + VARHDRSZ;
    case "time":
    case "timetz":
    case "timestamp":
    case "timestamptz":
      return mod.a;
    case "interval":
      return (INTERVAL_FULL_RANGE << 16) | mod.a;
    default:
      return -1;
  }
}
