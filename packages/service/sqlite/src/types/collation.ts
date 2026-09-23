import { SqliteError } from "../errors/index.ts";
import { compareSql, type SqlValue } from "./value.ts";

export type BuiltinCollation = "BINARY" | "NOCASE" | "RTRIM";

export function normalizeForCollation(value: SqlValue, name: string): SqlValue {
  const collation = builtinCollation(name);
  if (typeof value !== "string" || collation === "BINARY") return value;
  if (collation === "RTRIM") return value.replace(/ +$/u, "");

  let normalized = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    normalized += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : char;
  }
  return normalized;
}

export function compareWithCollation(a: SqlValue, b: SqlValue, name: string): number | null {
  return compareSql(normalizeForCollation(a, name), normalizeForCollation(b, name));
}

function builtinCollation(name: string): BuiltinCollation {
  const normalized = name.toUpperCase();
  if (normalized === "BINARY" || normalized === "NOCASE" || normalized === "RTRIM") return normalized;
  throw new SqliteError(`no such collation sequence: ${name}`, "other");
}
