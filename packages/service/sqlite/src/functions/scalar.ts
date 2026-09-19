import { SqliteError } from "../errors/index.ts";
import { assertBlobLength } from "../runtime/assert.ts";
import { globMatch, likeMatch } from "../expressions/like.ts";
import {
  affinityFromTypeName,
  asSqlReal,
  canonicalizeNumber,
  coerceToNumber,
  compareSql,
  formatRealAsText,
  isSqlReal,
  type SqlValue,
  storageClassOf,
  typeofSql,
  utf8Decode,
  utf8Encode,
} from "../types/value.ts";
import { sqliteAtoF } from "../types/sqlite-atof.ts";
import type { FunctionContext, ScalarFunction } from "./registry.ts";

/** Match bun:sqlite / SQLite 3.51.0 for drop-in parity. */
export const SQLITE_MEM_VERSION = "3.51.0";
export const SQLITE_MEM_SOURCE_ID =
  "2025-06-12 13:14:41 f0ca7bba1c5e232e5d279fad6338121ab55af0c8c68c84cdfb18ba5114dcaapl";

const COMPILE_OPTIONS = [
  "ENABLE_FTS3",
  "ENABLE_FTS4",
  "ENABLE_FTS5",
  "ENABLE_MATH_FUNCTIONS",
  "ENABLE_RTREE",
  "ENABLE_DBSTAT_VTAB",
  "ENABLE_BYTECODE_VTAB",
  "THREADSAFE=1",
] as const;

function text(value: SqlValue): string {
  if (value instanceof Uint8Array) return utf8Decode(value);
  return String(value);
}

/** CAST TEXT→INTEGER: leading space, optional sign, digit prefix (sqlite3Atoi64). */
function castTextToInteger(raw: string): number {
  let i = 0;
  while (i < raw.length && raw[i] === " ") i++;
  if (i >= raw.length) return 0;
  let sign = 1;
  if (raw[i] === "-") {
    sign = -1;
    i++;
  } else if (raw[i] === "+") i++;
  if (i >= raw.length || raw[i]! < "0" || raw[i]! > "9") return 0;
  let n = 0;
  while (i < raw.length && raw[i]! >= "0" && raw[i]! <= "9") {
    n = n * 10 + (raw.charCodeAt(i) - 48);
    i++;
  }
  return sign * n;
}

/** CAST TEXT→REAL/NUMERIC: prefix parse including fraction and exponent (sqlite3AtoF). */
function castTextToReal(raw: string): number {
  return sqliteAtoF(raw);
}

function castNumericFromValue(value: SqlValue, kind: "INTEGER" | "REAL" | "NUMERIC"): number {
  if (typeof value === "string") {
    return kind === "INTEGER" ? castTextToInteger(value) : castTextToReal(value);
  }
  if (value instanceof Uint8Array) {
    const decoded = utf8Decode(value);
    return kind === "INTEGER" ? castTextToInteger(decoded) : castTextToReal(decoded);
  }
  return coerceToNumber(value) ?? 0;
}

function numeric(value: SqlValue): number {
  return coerceToNumber(value) ?? 0;
}

export function castSqlValue(value: SqlValue, typeName: string): SqlValue {
  const affinity = affinityFromTypeName(typeName);
  if (value === null) return null;
  if (affinity === "BLOB") {
    return value instanceof Uint8Array ? value : utf8Encode(text(value));
  }
  if (affinity === "TEXT") {
    if (isSqlReal(value)) return formatRealAsText(value.value);
    if (typeof value === "number") {
      if (Number.isInteger(value) && Number.isSafeInteger(value)) return String(value);
      return formatRealAsText(value);
    }
    return text(value);
  }
  if (affinity === "INTEGER") return Math.trunc(castNumericFromValue(value, "INTEGER"));
  if (affinity === "REAL") return asSqlReal(castNumericFromValue(value, "REAL"));
  if (affinity === "NUMERIC") {
    const n = castNumericFromValue(value, "NUMERIC");
    if (Number.isInteger(n) && Number.isSafeInteger(n)) return Math.trunc(n);
    return canonicalizeNumber(n);
  }
  return value;
}

function trimChars(value: string, chars: string, left: boolean, right: boolean): string {
  const set = new Set([...chars]);
  const input = [...value];
  let start = 0;
  let end = input.length;
  if (left) while (start < end && set.has(input[start]!)) start++;
  if (right) while (end > start && set.has(input[end - 1]!)) end--;
  return input.slice(start, end).join("");
}

function substr(value: string, startValue: number, lengthValue?: number): string {
  const chars = [...value];
  const start = Math.trunc(startValue);
  let index = start > 0 ? start - 1 : start < 0 ? chars.length + start : 0;
  index = Math.max(0, index);
  if (lengthValue === undefined) return chars.slice(index).join("");
  const length = Math.trunc(lengthValue);
  if (length >= 0) return chars.slice(index, index + length).join("");
  return chars.slice(Math.max(0, index + length), index).join("");
}

function formatPrintf(format: string, args: SqlValue[]): string {
  let index = 0;
  return format.replace(
    /%([0 +\-#]*)(\d+)?(?:\.(\d+))?([%sdifgGxXcqQ])/g,
    (_match, flags: string, widthText: string | undefined, precisionText: string | undefined, kind: string) => {
      if (kind === "%") return "%";
      const value = args[index++] ?? null;
      const precision = precisionText === undefined ? undefined : Number(precisionText);
      let result: string;
      switch (kind) {
        case "d":
        case "i":
          result = String(Math.trunc(numeric(value)));
          break;
        case "f":
          result = numeric(value).toFixed(precision ?? 6);
          break;
        case "g":
        case "G":
          result = numeric(value)
            .toPrecision(precision ?? 6)
            .replace(/\.?0+(e|$)/i, "$1");
          break;
        case "x":
        case "X":
          result = Math.trunc(numeric(value)).toString(16);
          break;
        case "c":
          result = String.fromCodePoint(Math.trunc(numeric(value)));
          break;
        case "q":
          result = value === null ? "(NULL)" : text(value).replace(/'/g, "''");
          break;
        case "Q":
          result = value === null ? "NULL" : `'${text(value).replace(/'/g, "''")}'`;
          break;
        default:
          result = value === null ? "" : text(value);
      }
      if (kind === "G" || kind === "X") result = result.toUpperCase();
      const width = Number(widthText ?? 0);
      if (width > result.length) {
        const pad = flags.includes("0") ? "0" : " ";
        result = flags.includes("-") ? result.padEnd(width, pad) : result.padStart(width, pad);
      }
      return result;
    },
  );
}

function requireArgs(name: string, args: SqlValue[], min: number, max = min): void {
  if (args.length < min || args.length > max) {
    throw new SqliteError(`wrong number of arguments to function ${name}()`, "misuse");
  }
}

const scalarFunctions: Record<string, ScalarFunction> = {
  abs(args) {
    requireArgs("abs", args, 1);
    const value = args[0]!;
    if (value === null) return null;
    if (typeof value === "bigint") return value < 0n ? -value : value;
    return Math.abs(numeric(value));
  },
  coalesce(args) {
    if (args.length < 2) throw new SqliteError("wrong number of arguments to function coalesce()", "misuse");
    return args.find((value) => value !== null) ?? null;
  },
  ifnull(args) {
    requireArgs("ifnull", args, 2);
    return args[0] ?? args[1]!;
  },
  nullif(args) {
    requireArgs("nullif", args, 2);
    const comparison = compareSql(args[0]!, args[1]!);
    return comparison === 0 ? null : args[0]!;
  },
  typeof(args) {
    requireArgs("typeof", args, 1);
    return typeofSql(args[0]!);
  },
  length(args) {
    requireArgs("length", args, 1);
    const value = args[0]!;
    if (value === null) return null;
    if (value instanceof Uint8Array) return value.length;
    return [...text(value)].length;
  },
  lower(args) {
    requireArgs("lower", args, 1);
    return args[0] === null ? null : text(args[0]!).replace(/[A-Z]/g, (c) => c.toLowerCase());
  },
  upper(args) {
    requireArgs("upper", args, 1);
    return args[0] === null ? null : text(args[0]!).replace(/[a-z]/g, (c) => c.toUpperCase());
  },
  trim(args) {
    requireArgs("trim", args, 1, 2);
    if (args[0] === null || args[1] === null) return null;
    return trimChars(text(args[0]!), args[1] === undefined ? " " : text(args[1]), true, true);
  },
  ltrim(args) {
    requireArgs("ltrim", args, 1, 2);
    if (args[0] === null || args[1] === null) return null;
    return trimChars(text(args[0]!), args[1] === undefined ? " " : text(args[1]), true, false);
  },
  rtrim(args) {
    requireArgs("rtrim", args, 1, 2);
    if (args[0] === null || args[1] === null) return null;
    return trimChars(text(args[0]!), args[1] === undefined ? " " : text(args[1]), false, true);
  },
  substr(args) {
    requireArgs("substr", args, 2, 3);
    if (args[0] === null || args[1] === null || args[2] === null) return null;
    return substr(text(args[0]!), numeric(args[1]!), args[2] === undefined ? undefined : numeric(args[2]));
  },
  substring(args, context) {
    return scalarFunctions.substr!(args, context);
  },
  replace(args) {
    requireArgs("replace", args, 3);
    if (args.some((value) => value === null)) return null;
    const search = text(args[1]!);
    return search === "" ? text(args[0]!) : text(args[0]!).split(search).join(text(args[2]!));
  },
  round(args) {
    requireArgs("round", args, 1, 2);
    if (args[0] === null) return null;
    const places = Math.max(0, Math.min(30, Math.trunc(numeric(args[1] ?? 0))));
    const factor = 10 ** places;
    const scaled = numeric(args[0]!) * factor;
    return (scaled < 0 ? -Math.round(-scaled) : Math.round(scaled)) / factor;
  },
  min(args) {
    if (args.length < 2) throw new SqliteError("wrong number of arguments to function min()", "misuse");
    if (args.some((value) => value === null)) return null;
    return args.reduce((best, value) => (compareSql(value, best)! < 0 ? value : best));
  },
  max(args) {
    if (args.length < 2) throw new SqliteError("wrong number of arguments to function max()", "misuse");
    if (args.some((value) => value === null)) return null;
    return args.reduce((best, value) => (compareSql(value, best)! > 0 ? value : best));
  },
  random(args, context) {
    requireArgs("random", args, 0);
    if (context.random) return context.random();
    // Fallback deterministic stream when evaluated outside a Database (e.g. unit helpers).
    return 0n;
  },
  randomblob(args, context) {
    requireArgs("randomblob", args, 1);
    if (args[0] === null) return null;
    const length = Math.max(0, Math.trunc(numeric(args[0]!)));
    assertBlobLength(length, "randomblob");
    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const bits = context.randomU64?.() ?? 0n;
      for (let shift = 0; shift < 64 && offset < length; shift += 8) {
        out[offset++] = Number((bits >> BigInt(shift)) & 0xffn);
      }
    }
    return out;
  },
  zeroblob(args) {
    requireArgs("zeroblob", args, 1);
    if (args[0] === null) return null;
    const length = Math.max(0, Math.trunc(numeric(args[0]!)));
    assertBlobLength(length, "zeroblob");
    return new Uint8Array(length);
  },
  hex(args) {
    requireArgs("hex", args, 1);
    if (args[0] === null) return "";
    const bytes = args[0] instanceof Uint8Array ? args[0] : utf8Encode(text(args[0]!));
    return [...bytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  },
  quote(args) {
    requireArgs("quote", args, 1);
    const value = args[0]!;
    if (value === null) return "NULL";
    if (value instanceof Uint8Array) return `X'${scalarFunctions.hex!([value], {})}'`;
    if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
    if (typeof value === "number" && !Number.isFinite(value)) return value < 0 ? "-9.0e+999" : "9.0e+999";
    return String(value);
  },
  printf(args) {
    if (args.length === 0 || args[0] === null) return null;
    return formatPrintf(text(args[0]!), args.slice(1));
  },
  changes(args, context) {
    requireArgs("changes", args, 0);
    return context.changes?.() ?? 0;
  },
  total_changes(args, context) {
    requireArgs("total_changes", args, 0);
    return context.totalChanges?.() ?? 0;
  },
  last_insert_rowid(args, context) {
    requireArgs("last_insert_rowid", args, 0);
    return context.lastInsertRowid?.() ?? 0;
  },
  sqlite_version(args) {
    requireArgs("sqlite_version", args, 0);
    return SQLITE_MEM_VERSION;
  },
  sqlite_source_id(args) {
    requireArgs("sqlite_source_id", args, 0);
    return SQLITE_MEM_SOURCE_ID;
  },
  sqlite_compileoption_used(args) {
    requireArgs("sqlite_compileoption_used", args, 1);
    if (args[0] === null) return null;
    const needle = text(args[0]!)
      .toUpperCase()
      .replace(/^SQLITE_/, "");
    return COMPILE_OPTIONS.some((opt) => opt === needle || opt.startsWith(`${needle}=`)) ? 1 : 0;
  },
  sqlite_compileoption_get(args) {
    requireArgs("sqlite_compileoption_get", args, 1);
    if (args[0] === null) return null;
    const index = Math.trunc(numeric(args[0]!));
    if (index < 0 || index >= COMPILE_OPTIONS.length) return null;
    return COMPILE_OPTIONS[index]!;
  },
  sqlite_log(args) {
    requireArgs("sqlite_log", args, 2);
    return null;
  },
  load_extension(args) {
    requireArgs("load_extension", args, 1, 2);
    throw new SqliteError("not authorized", "misuse");
  },
  like(args, context) {
    requireArgs("like", args, 2, 3);
    if (args[0] === null || args[1] === null || args[2] === null) return null;
    // like(pattern, string[, escape]) ≡ string LIKE pattern [ESCAPE escape]
    const escape = args[2] === undefined ? null : text(args[2]!);
    return likeMatch(text(args[1]!), text(args[0]!), escape, context.caseSensitiveLike === true) ? 1 : 0;
  },
  glob(args) {
    requireArgs("glob", args, 2);
    if (args[0] === null || args[1] === null) return null;
    // glob(pattern, string) ≡ string GLOB pattern
    return globMatch(text(args[1]!), text(args[0]!)) ? 1 : 0;
  },
  match() {
    throw new SqliteError("unable to use function MATCH in the requested context", "unsupported");
  },
  char(args) {
    if (args.length === 0) return "";
    let out = "";
    for (const arg of args) {
      if (arg === null) continue;
      const code = Math.trunc(numeric(arg));
      if (code > 0) out += String.fromCodePoint(code);
    }
    return out;
  },
  format(args, context) {
    return scalarFunctions.printf!(args, context);
  },
  iif(args) {
    requireArgs("iif", args, 3);
    const cond = args[0];
    if (cond === null) return args[2]!;
    if (typeof cond === "number" || typeof cond === "bigint") {
      return Number(cond) !== 0 ? args[1]! : args[2]!;
    }
    if (typeof cond === "string") return cond.length > 0 ? args[1]! : args[2]!;
    if (cond instanceof Uint8Array) return cond.length > 0 ? args[1]! : args[2]!;
    return args[1]!;
  },
  if(args, context) {
    return scalarFunctions.iif!(args, context);
  },
  instr(args) {
    requireArgs("instr", args, 2);
    if (args[0] === null || args[1] === null) return null;
    if (args[0] instanceof Uint8Array || args[1] instanceof Uint8Array) {
      const hay = args[0] instanceof Uint8Array ? args[0] : utf8Encode(text(args[0]!));
      const needle = args[1] instanceof Uint8Array ? args[1] : utf8Encode(text(args[1]!));
      if (needle.length === 0) return 1;
      outer: for (let i = 0; i <= hay.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
          if (hay[i + j] !== needle[j]) continue outer;
        }
        return i + 1;
      }
      return 0;
    }
    const hay = text(args[0]!);
    const needle = text(args[1]!);
    if (needle === "") return 1;
    const idx = hay.indexOf(needle);
    return idx < 0 ? 0 : [...hay.slice(0, idx)].length + 1;
  },
  unicode(args) {
    requireArgs("unicode", args, 1);
    if (args[0] === null) return null;
    const s = text(args[0]!);
    if (s.length === 0) return null;
    return s.codePointAt(0)!;
  },
  octet_length(args) {
    requireArgs("octet_length", args, 1);
    if (args[0] === null) return null;
    if (args[0] instanceof Uint8Array) return args[0].length;
    return utf8Encode(text(args[0]!)).length;
  },
  unhex(args) {
    requireArgs("unhex", args, 1, 2);
    if (args[0] === null) return null;
    let hex = text(args[0]!).replace(/\s+/g, "");
    if (args[1] !== undefined && args[1] !== null) {
      const sep = text(args[1]!);
      hex = text(args[0]!).split(sep).join("");
    }
    if (hex.length % 2 !== 0) return null;
    if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  },
  concat(args) {
    if (args.some((v) => v === null)) return null;
    return args.map((v) => text(v!)).join("");
  },
  concat_ws(args) {
    if (args.length < 2) throw new SqliteError("wrong number of arguments to function concat_ws()", "misuse");
    if (args[0] === null) return null;
    const sep = text(args[0]!);
    const parts: string[] = [];
    for (const arg of args.slice(1)) {
      if (arg === null) continue;
      parts.push(text(arg));
    }
    return parts.join(sep);
  },
  unistr(args) {
    requireArgs("unistr", args, 1);
    if (args[0] === null) return null;
    const input = text(args[0]!);
    let out = "";
    for (let i = 0; i < input.length; i++) {
      if (input[i] === "\\" && input[i + 1] === "u") {
        const hex = input.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new SqliteError("invalid Unicode escape in unistr()", "other");
        }
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += 5;
      } else {
        out += input[i];
      }
    }
    return out;
  },
  unistr_quote(args) {
    requireArgs("unistr_quote", args, 1);
    if (args[0] === null) return "NULL";
    const s = text(args[0]!);
    let needs = false;
    let escaped = "";
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x20 || cp === 0x7f) {
        needs = true;
        escaped += `\\u${cp.toString(16).padStart(4, "0")}`;
      } else if (ch === "'") {
        escaped += "''";
      } else if (ch === "\\") {
        needs = true;
        escaped += "\\\\";
      } else {
        escaped += ch;
      }
    }
    return needs ? `unistr('${escaped}')` : `'${escaped}'`;
  },
  likelihood(args) {
    requireArgs("likelihood", args, 2);
    const p = numOrThrow(args[1], "likelihood");
    if (p === null || p < 0 || p > 1) {
      throw new SqliteError("second argument to likelihood() must be a constant between 0.0 and 1.0", "misuse");
    }
    return args[0]!;
  },
  likely(args) {
    requireArgs("likely", args, 1);
    return args[0]!;
  },
  unlikely(args) {
    requireArgs("unlikely", args, 1);
    return args[0]!;
  },
  unknown() {
    return null;
  },
  uuid(args, context) {
    requireArgs("uuid", args, 0);
    return formatUuid(nextUuidBytes(context));
  },
  uuid_str(args) {
    requireArgs("uuid_str", args, 1);
    if (args[0] === null) return null;
    if (typeof args[0] === "string") return args[0].toLowerCase();
    if (args[0] instanceof Uint8Array && args[0].length === 16) return formatUuid(args[0]);
    return null;
  },
  uuid_blob(args) {
    requireArgs("uuid_blob", args, 1);
    if (args[0] === null) return null;
    if (args[0] instanceof Uint8Array && args[0].length === 16) return args[0];
    if (typeof args[0] === "string") {
      const hex = args[0].replace(/-/g, "");
      if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
      const out = new Uint8Array(16);
      for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    return null;
  },
  // FTS/RTREE helpers registered as context-sensitive stubs; real work is in MATCH/vtab paths.
  optimize() {
    throw new SqliteError("unable to use function optimize in the requested context", "unsupported");
  },
  fts5() {
    throw new SqliteError("unable to use function fts5 in the requested context", "unsupported");
  },
  fts5_source_id(args) {
    requireArgs("fts5_source_id", args, 0);
    return `fts5: ${SQLITE_MEM_SOURCE_ID}`;
  },
  fts5_get_locale() {
    return null;
  },
  fts5_locale(args) {
    requireArgs("fts5_locale", args, 1, 2);
    return args[0] ?? null;
  },
  fts5_insttoken(args) {
    requireArgs("fts5_insttoken", args, 1);
    return args[0]!;
  },
  fts3_tokenizer() {
    throw new SqliteError("unknown tokenizer: ", "other");
  },
};

function numOrThrow(value: SqlValue | undefined, name: string): number | null {
  if (value === undefined) throw new SqliteError(`wrong number of arguments to function ${name}()`, "misuse");
  if (value === null) return null;
  return coerceToNumber(value);
}

function nextUuidBytes(context: FunctionContext): Uint8Array {
  const out = new Uint8Array(16);
  let offset = 0;
  while (offset < 16) {
    const bits = context.randomU64?.() ?? 0n;
    for (let shift = 0; shift < 64 && offset < 16; shift += 8) {
      out[offset++] = Number((bits >> BigInt(shift)) & 0xffn);
    }
  }
  // RFC 4122 version 4 / variant bits
  out[6] = (out[6]! & 0x0f) | 0x40;
  out[8] = (out[8]! & 0x3f) | 0x80;
  return out;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getScalarFunctions(): Readonly<Record<string, ScalarFunction>> {
  return scalarFunctions;
}

export function invokeScalar(name: string, args: SqlValue[], context: FunctionContext = {}): SqlValue {
  const fn = scalarFunctions[name.toLowerCase()];
  if (!fn) throw new SqliteError(`no such function: ${name}`, "other");
  return fn(args, context);
}

export { storageClassOf };
