import { pgError } from "../errors/error.ts";
import { quoteIdentifier } from "../sql/keywords.ts";

/**
 * `regnamespace`: an oid that reads and prints as a schema name (regnamespacein /
 * regnamespaceout). The catalog lookups stay with the caller; this is the text form.
 */

/** Schemas every database has, with the oids PostgreSQL gives them (information_schema's is not fixed). */
export const BUILTIN_NAMESPACES: ReadonlyArray<readonly [name: string, oid: number]> = [
  ["pg_toast", 99],
  ["pg_catalog", 11],
  ["information_schema", 13212],
];

export const builtinNamespaceOid = (name: string): number | undefined =>
  BUILTIN_NAMESPACES.find(([builtin]) => builtin === name)?.[1];

export const builtinNamespaceName = (oid: number): string | undefined =>
  BUILTIN_NAMESPACES.find(([, builtin]) => builtin === oid)?.[0];

const OID_MAX = 4294967295n;

/** oidin: an unsigned 32-bit integer; a negative literal is its two's-complement reading. */
export function parseOidText(text: string): number {
  const trimmed = text.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw pgError("invalid_text_representation", `invalid input syntax for type oid: "${text}"`);
  }
  const value = BigInt(trimmed);
  if (value > OID_MAX || value < -2147483648n) {
    throw pgError("numeric_value_out_of_range", `value "${text}" is out of range for type oid`, "22003");
  }
  return Number(value < 0n ? value + OID_MAX + 1n : value);
}

/** A cast from an integer type: int2/int4 reinterpret their bits, int8 must fit. */
export function oidFromInteger(value: number | bigint): number {
  if (typeof value === "number") return value >>> 0;
  if (value < 0n || value > OID_MAX) throw pgError("numeric_value_out_of_range", "OID out of range", "22003");
  return Number(value);
}

const invalidName = (): never => {
  throw pgError("syntax", "invalid name syntax", "42602");
};

/**
 * Split regnamespace input as SplitIdentifierString does. `-` and an all-digit string are
 * oids; anything else must be exactly one identifier, case-folded unless double-quoted.
 */
export function parseNamespaceInput(text: string): { oid: number } | { name: string } {
  const parsed = parseRelationInput(text);
  if ("oid" in parsed) return parsed;
  if (parsed.parts.length !== 1) invalidName();
  return { name: parsed.parts[0]! };
}

export function parseRelationInput(text: string): { oid: number } | { parts: string[] } {
  if (text === "-") return { oid: 0 };
  if (/^\d+$/.test(text)) return { oid: parseOidText(text) };
  const names: string[] = [];
  let at = 0;
  const skipSpace = () => {
    while (at < text.length && /\s/.test(text[at]!)) at++;
  };
  skipSpace();
  while (at < text.length) {
    if (text[at] === '"') {
      let name = "";
      at++;
      for (;;) {
        const close = text.indexOf('"', at);
        if (close === -1) invalidName();
        name += text.slice(at, close);
        at = close + 1;
        if (text[at] !== '"') break;
        // a doubled quote is one quote inside the name
        name += '"';
        at++;
      }
      names.push(name);
    } else {
      const start = at;
      while (at < text.length && text[at] !== "." && !/\s/.test(text[at]!)) at++;
      if (at === start) invalidName();
      names.push(text.slice(start, at).toLowerCase());
    }
    skipSpace();
    if (at === text.length) break;
    if (text[at] !== ".") invalidName();
    at++;
    skipSpace();
    // a separator must be followed by another name
    if (at === text.length) invalidName();
  }
  if (names.length === 0 || names.length > 3) invalidName();
  return { parts: names };
}

/** regnamespaceout: `-` for zero, the quoted schema name, or the bare number when no schema has that oid. */
export function namespaceText(oid: number, name: string | null | undefined): string {
  if (oid === 0) return "-";
  return name === null || name === undefined ? String(oid) : quoteIdentifier(name);
}
