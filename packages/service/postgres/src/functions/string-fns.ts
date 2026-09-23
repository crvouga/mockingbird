import { pgError, unsupported } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { pgRegexToJs, regexFlags, similarToRegex } from "../expressions/pattern.ts";
import { castTo } from "../types/cast.ts";
import { datumText, makeArray, type TypedValue, tv } from "../types/value.ts";
import { argInt, argText, type ScalarFn, strict } from "./util.ts";

const encoderUtf8 = new TextEncoder();
const decoderUtf8 = new TextDecoder("utf-8", { fatal: false });

function chars(s: string): string[] {
  return [...s];
}

/** PG substr semantics: 1-based, negative start shifts window. */
export function substrImpl(s: string, start: number, len?: number): string {
  const cs = chars(s);
  if (len === undefined) {
    const from = Math.max(start, 1);
    return cs.slice(from - 1).join("");
  }
  if (len < 0) throw pgError("substring_error", "negative substring length not allowed", "22011");
  const end = start + len; // exclusive, 1-based
  const from = Math.max(start, 1);
  const to = Math.max(end, 1);
  if (to <= from) return "";
  return cs.slice(from - 1, to - 1).join("");
}

export function getStringFunctions(): Map<string, ScalarFn> {
  const m = new Map<string, ScalarFn>();

  m.set(
    "length",
    strict("int4", (ctx, args) => {
      const a = args[0]!;
      if (a.t === "bytea") return tv("int4", (a.v as Uint8Array).length);
      if (a.t === "tsvector") {
        throw unsupported("length(tsvector) is registered in tsearch functions");
      }
      return tv("int4", chars(argText(ctx, a)).length);
    }),
  );
  m.set(
    "char_length",
    strict("int4", (ctx, args) => tv("int4", chars(argText(ctx, args[0]!)).length)),
  );
  m.set("character_length", m.get("char_length")!);
  m.set(
    "octet_length",
    strict("int4", (ctx, args) => {
      const a = args[0]!;
      if (a.t === "bytea") return tv("int4", (a.v as Uint8Array).length);
      return tv("int4", encoderUtf8.encode(argText(ctx, a)).length);
    }),
  );
  m.set(
    "bit_length",
    strict("int4", (ctx, args) => {
      const a = args[0]!;
      if (a.t === "bit" || a.t === "varbit") return tv("int4", (a.v as string).length);
      if (a.t === "bytea") return tv("int4", (a.v as Uint8Array).length * 8);
      return tv("int4", encoderUtf8.encode(argText(ctx, a)).length * 8);
    }),
  );
  m.set(
    "lower",
    strict("text", (ctx, args) => tv("text", argText(ctx, args[0]!).toLowerCase())),
  );
  m.set(
    "upper",
    strict("text", (ctx, args) => tv("text", argText(ctx, args[0]!).toUpperCase())),
  );
  m.set(
    "initcap",
    strict("text", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      return tv(
        "text",
        s.replace(/[0-9A-Za-z\u00c0-\uffff]+/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()),
      );
    }),
  );
  m.set(
    "substr",
    strict("text", (ctx, args) => {
      const a = args[0]!;
      if (a.t === "bytea") {
        const bytes = a.v as Uint8Array;
        const start = argInt(ctx, args[1]!);
        const len = args.length > 2 ? argInt(ctx, args[2]!) : undefined;
        return tv("bytea", byteaSubstr(bytes, start, len));
      }
      const s = argText(ctx, a);
      const start = argInt(ctx, args[1]!);
      const len = args.length > 2 ? argInt(ctx, args[2]!) : undefined;
      return tv("text", substrImpl(s, start, len));
    }),
  );
  // substring(string, pattern): 2-arg form with a non-numeric second arg is POSIX regex extraction
  m.set(
    "substring",
    strict("text", (ctx, args) => {
      const isIntLike = (v: TypedValue): boolean => {
        if (v.t === "int2" || v.t === "int4" || v.t === "int8" || v.t === "numeric") return true;
        return v.t === "unknown" && /^\s*[+-]?\d+\s*$/.test(String(v.v));
      };
      if (args.length === 2 && !isIntLike(args[1]!)) {
        const s = argText(ctx, args[0]!);
        const pattern = argText(ctx, args[1]!);
        const js = new RegExp(pgRegexToJs(pattern), regexFlags("", true));
        const match = js.exec(s);
        if (!match) return tv("text", null);
        return tv("text", match[1] !== undefined ? match[1] : match[0]);
      }
      return m.get("substr")!(ctx, args);
    }),
  );
  m.set(
    "substring_similar",
    strict("text", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      const pattern = argText(ctx, args[1]!);
      const escape = argText(ctx, args[2]!);
      return tv("text", substringSimilar(s, pattern, escape));
    }),
  );
  m.set(
    "strpos",
    strict("int4", (ctx, args) => {
      const hay = chars(argText(ctx, args[0]!));
      const needle = chars(argText(ctx, args[1]!));
      if (needle.length === 0) return tv("int4", 1);
      outer: for (let i = 0; i + needle.length <= hay.length; i++) {
        for (let j = 0; j < needle.length; j++) {
          if (hay[i + j] !== needle[j]) continue outer;
        }
        return tv("int4", i + 1);
      }
      return tv("int4", 0);
    }),
  );
  m.set("position", m.get("strpos")!);
  m.set(
    "left",
    strict("text", (ctx, args) => {
      const cs = chars(argText(ctx, args[0]!));
      const n = argInt(ctx, args[1]!);
      return tv("text", n >= 0 ? cs.slice(0, n).join("") : cs.slice(0, Math.max(cs.length + n, 0)).join(""));
    }),
  );
  m.set(
    "right",
    strict("text", (ctx, args) => {
      const cs = chars(argText(ctx, args[0]!));
      const n = argInt(ctx, args[1]!);
      return tv(
        "text",
        n >= 0 ? cs.slice(Math.max(cs.length - n, 0)).join("") : cs.slice(Math.min(-n, cs.length)).join(""),
      );
    }),
  );
  m.set(
    "lpad",
    strict("text", (ctx, args) => {
      const s = chars(argText(ctx, args[0]!));
      const len = argInt(ctx, args[1]!);
      const fill = args.length > 2 ? chars(argText(ctx, args[2]!)) : [" "];
      return tv("text", pad(s, len, fill, true));
    }),
  );
  m.set(
    "rpad",
    strict("text", (ctx, args) => {
      const s = chars(argText(ctx, args[0]!));
      const len = argInt(ctx, args[1]!);
      const fill = args.length > 2 ? chars(argText(ctx, args[2]!)) : [" "];
      return tv("text", pad(s, len, fill, false));
    }),
  );
  m.set(
    "ltrim",
    strict("text", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      const set = new Set(chars(args.length > 1 ? argText(ctx, args[1]!) : " "));
      const cs = chars(s);
      let i = 0;
      while (i < cs.length && set.has(cs[i]!)) i++;
      return tv("text", cs.slice(i).join(""));
    }),
  );
  m.set(
    "rtrim",
    strict("text", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      const set = new Set(chars(args.length > 1 ? argText(ctx, args[1]!) : " "));
      const cs = chars(s);
      let end = cs.length;
      while (end > 0 && set.has(cs[end - 1]!)) end--;
      return tv("text", cs.slice(0, end).join(""));
    }),
  );
  m.set(
    "btrim",
    strict("text", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      const set = new Set(chars(args.length > 1 ? argText(ctx, args[1]!) : " "));
      const cs = chars(s);
      let i = 0;
      let end = cs.length;
      while (i < end && set.has(cs[i]!)) i++;
      while (end > i && set.has(cs[end - 1]!)) end--;
      return tv("text", cs.slice(i, end).join(""));
    }),
  );
  m.set("trim", m.get("btrim")!);
  m.set(
    "repeat",
    strict("text", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      const n = argInt(ctx, args[1]!);
      return tv("text", n > 0 ? s.repeat(n) : "");
    }),
  );
  m.set(
    "replace",
    strict("text", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      const from = argText(ctx, args[1]!);
      const to = argText(ctx, args[2]!);
      if (from === "") return tv("text", s);
      return tv("text", s.split(from).join(to));
    }),
  );
  m.set(
    "reverse",
    strict("text", (ctx, args) => tv("text", chars(argText(ctx, args[0]!)).reverse().join(""))),
  );
  m.set(
    "split_part",
    strict("text", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      const delim = argText(ctx, args[1]!);
      const n = argInt(ctx, args[2]!);
      if (n === 0) throw pgError("invalid_parameter_value", "field position must not be zero");
      const parts = delim === "" ? [s] : s.split(delim);
      const idx = n > 0 ? n - 1 : parts.length + n;
      return tv("text", parts[idx] ?? "");
    }),
  );
  m.set(
    "translate",
    strict("text", (ctx, args) => {
      const s = chars(argText(ctx, args[0]!));
      const from = chars(argText(ctx, args[1]!));
      const to = chars(argText(ctx, args[2]!));
      const map = new Map<string, string | null>();
      for (let i = 0; i < from.length; i++) map.set(from[i]!, to[i] ?? null);
      let out = "";
      for (const c of s) {
        if (map.has(c)) {
          const r = map.get(c);
          if (r !== null) out += r;
        } else out += c;
      }
      return tv("text", out);
    }),
  );
  m.set(
    "ascii",
    strict("int4", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      if (s === "") return tv("int4", 0);
      return tv("int4", s.codePointAt(0)!);
    }),
  );
  m.set(
    "chr",
    strict("text", (ctx, args) => {
      const n = argInt(ctx, args[0]!);
      if (n === 0) throw pgError("invalid_parameter_value", "null character not permitted", "54000");
      if (n < 0 || n > 1114111 || (n >= 0xd800 && n <= 0xdfff)) {
        throw pgError("invalid_parameter_value", `requested character too large for encoding: ${n}`);
      }
      return tv("text", String.fromCodePoint(n));
    }),
  );
  // concat renders via typoutput (bool -> 't'/'f'), not the bool->text cast
  const outputText = (ctx: EngineCtx, a: TypedValue): string =>
    a.t === "unknown" ? String(a.v) : datumText(a.t, a.v as NonNullable<typeof a.v>, ctx);
  m.set("concat", (ctx, args) => {
    let out = "";
    for (const a of args) {
      if (a.v === null) continue;
      out += outputText(ctx, a);
    }
    return tv("text", out);
  });
  m.set("concat_ws", (ctx, args) => {
    if (args.length === 0 || args[0]!.v === null) return tv("text", null);
    const sep = argText(ctx, args[0]!);
    const parts: string[] = [];
    for (const a of args.slice(1)) {
      if (a.v === null) continue;
      parts.push(outputText(ctx, a));
    }
    return tv("text", parts.join(sep));
  });
  m.set(
    "starts_with",
    strict("bool", (ctx, args) => tv("bool", argText(ctx, args[0]!).startsWith(argText(ctx, args[1]!)))),
  );
  m.set(
    "md5",
    strict("text", (ctx, args) => {
      const a = args[0]!;
      const bytes = a.t === "bytea" ? (a.v as Uint8Array) : encoderUtf8.encode(argText(ctx, a));
      return tv("text", md5Hex(bytes));
    }),
  );
  m.set(
    "to_hex",
    strict("text", (ctx, args) => {
      const a = args[0]!;
      if (a.t === "int8") {
        const v = a.v as bigint;
        return tv("text", (v < 0n ? (1n << 64n) + v : v).toString(16));
      }
      const n = argInt(ctx, a);
      return tv("text", (n < 0 ? 0x100000000 + n : n).toString(16));
    }),
  );
  m.set(
    "quote_ident",
    strict("text", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      if (/^[a-z_][a-z0-9_$]*$/.test(s) && !QUOTE_KEYWORDS.has(s)) return tv("text", s);
      return tv("text", `"${s.replaceAll('"', '""')}"`);
    }),
  );
  m.set(
    "quote_literal",
    strict("text", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      return tv("text", quoteLiteral(s));
    }),
  );
  m.set("quote_nullable", (ctx, args) => {
    const a = args[0]!;
    if (a.v === null) return tv("text", "NULL");
    return tv("text", quoteLiteral(argText(ctx, a)));
  });
  m.set("format", (ctx, args) => {
    if (args.length === 0 || args[0]!.v === null) return tv("text", null);
    return tv("text", formatImpl(ctx, argText(ctx, args[0]!), args.slice(1)));
  });

  // --- regex ---------------------------------------------------------------
  m.set(
    "regexp_replace",
    strict("text", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      const pattern = argText(ctx, args[1]!);
      const replacement = argText(ctx, args[2]!);
      const flags = args.length > 3 ? argText(ctx, args[3]!) : "";
      const js = new RegExp(pgRegexToJs(pattern), regexFlags(flags, !flags.includes("g")));
      const rep = replacement.replace(/\\(\d|&|\\)/g, (_, d: string) =>
        d === "&" ? "$&" : d === "\\" ? "\\" : `$${d}`,
      );
      return tv("text", s.replace(js, rep));
    }),
  );
  m.set(
    "regexp_match",
    strict("text[]", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      const pattern = argText(ctx, args[1]!);
      const flags = args.length > 2 ? argText(ctx, args[2]!) : "";
      const js = new RegExp(pgRegexToJs(pattern), regexFlags(flags, true));
      const match = js.exec(s);
      if (!match) return tv("text[]", null);
      const groups = match.length > 1 ? match.slice(1) : [match[0]];
      return tv(
        "text[]",
        makeArray(
          "text",
          groups.map((g) => (g === undefined ? null : g)),
        ),
      );
    }),
  );
  m.set(
    "regexp_count",
    strict("int4", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      const pattern = argText(ctx, args[1]!);
      const start = args.length > 2 ? argInt(ctx, args[2]!) : 1;
      const flags = args.length > 3 ? argText(ctx, args[3]!) : "";
      if (start < 1) throw pgError("invalid_parameter_value", `invalid value for parameter "start": ${start}`);
      const js = new RegExp(pgRegexToJs(pattern), `${regexFlags(flags, true)}g`);
      const sub = chars(s)
        .slice(start - 1)
        .join("");
      let count = 0;
      for (const _ of sub.matchAll(js)) count++;
      return tv("int4", count);
    }),
  );
  m.set(
    "regexp_like",
    strict("bool", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      const pattern = argText(ctx, args[1]!);
      const flags = args.length > 2 ? argText(ctx, args[2]!) : "";
      const js = new RegExp(pgRegexToJs(pattern), regexFlags(flags, true));
      return tv("bool", js.test(s));
    }),
  );
  m.set(
    "regexp_substr",
    strict("text", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      const pattern = argText(ctx, args[1]!);
      const start = args.length > 2 ? argInt(ctx, args[2]!) : 1;
      const nth = args.length > 3 ? argInt(ctx, args[3]!) : 1;
      const flags = args.length > 4 ? argText(ctx, args[4]!) : "";
      const js = new RegExp(pgRegexToJs(pattern), `${regexFlags(flags, true)}g`);
      const sub = chars(s)
        .slice(start - 1)
        .join("");
      let i = 0;
      for (const match of sub.matchAll(js)) {
        i++;
        if (i === nth) return tv("text", match[0]);
      }
      return tv("text", null);
    }),
  );
  m.set(
    "regexp_instr",
    strict("int4", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      const pattern = argText(ctx, args[1]!);
      const start = args.length > 2 ? argInt(ctx, args[2]!) : 1;
      const nth = args.length > 3 ? argInt(ctx, args[3]!) : 1;
      const endoption = args.length > 4 ? argInt(ctx, args[4]!) : 0;
      const flags = args.length > 5 ? argText(ctx, args[5]!) : "";
      if (start < 1) throw pgError("invalid_parameter_value", `invalid value for parameter "start": ${start}`);
      if (endoption !== 0 && endoption !== 1) {
        throw pgError("invalid_parameter_value", `invalid value for parameter "endoption": ${endoption}`);
      }
      const js = new RegExp(pgRegexToJs(pattern), `${regexFlags(flags, true)}g`);
      const sub = chars(s)
        .slice(start - 1)
        .join("");
      let i = 0;
      for (const match of sub.matchAll(js)) {
        i++;
        if (i === nth) {
          const base = start - 1 + chars(sub.slice(0, match.index)).length;
          return tv("int4", endoption === 0 ? base + 1 : base + chars(match[0]).length + 1);
        }
      }
      return tv("int4", 0);
    }),
  );
  m.set(
    "regexp_split_to_array",
    strict("text[]", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      const pattern = argText(ctx, args[1]!);
      const flags = args.length > 2 ? argText(ctx, args[2]!) : "";
      const js = new RegExp(pgRegexToJs(pattern), `${regexFlags(flags, true)}g`);
      const parts = regexpSplit(s, js);
      return tv("text[]", makeArray("text", parts));
    }),
  );

  m.set(
    "string_to_array",
    strict("text[]", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      const delim = args[1]!.v === null ? null : argText(ctx, args[1]!);
      const nullStr = args.length > 2 && args[2]!.v !== null ? argText(ctx, args[2]!) : null;
      let parts: string[];
      if (delim === null) parts = chars(s);
      else if (delim === "") parts = [s];
      else parts = s.split(delim);
      if (s === "" && delim !== null) parts = delim === "" ? [""] : [""];
      const items = parts.map((p) => (nullStr !== null && p === nullStr ? null : p));
      if (s === "")
        return tv(
          "text[]",
          makeArray("text", items.length === 1 && items[0] === "" ? (nullStr === "" ? [null] : [""]) : items),
        );
      return tv("text[]", makeArray("text", items));
    }),
  );

  m.set(
    "encode",
    strict("text", (ctx, args) => {
      const bytes = castTo(ctx, args[0]!, "bytea", { explicit: true }).v as Uint8Array;
      const fmt = argText(ctx, args[1]!);
      return tv("text", encodeBytes(bytes, fmt));
    }),
  );
  m.set(
    "decode",
    strict("bytea", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      const fmt = argText(ctx, args[1]!);
      return tv("bytea", decodeBytes(s, fmt));
    }),
  );
  m.set(
    "convert_to",
    strict("bytea", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      const enc = argText(ctx, args[1]!).toLowerCase().replaceAll("-", "").replaceAll("_", "");
      if (enc !== "utf8" && enc !== "sqlascii") throw unsupported(`convert_to encoding ${enc}`);
      return tv("bytea", encoderUtf8.encode(s));
    }),
  );
  m.set(
    "convert_from",
    strict("text", (ctx, args) => {
      const bytes = castTo(ctx, args[0]!, "bytea", { explicit: true }).v as Uint8Array;
      const enc = argText(ctx, args[1]!).toLowerCase().replaceAll("-", "").replaceAll("_", "");
      if (enc !== "utf8" && enc !== "sqlascii") throw unsupported(`convert_from encoding ${enc}`);
      return tv("text", decoderUtf8.decode(bytes));
    }),
  );
  m.set(
    "get_byte",
    strict("int4", (ctx, args) => {
      const bytes = args[0]!.v as Uint8Array;
      const i = argInt(ctx, args[1]!);
      if (i < 0 || i >= bytes.length) throw pgError("array_subscript_error", "index out of range", "2202E");
      return tv("int4", bytes[i]!);
    }),
  );
  m.set(
    "set_byte",
    strict("bytea", (ctx, args) => {
      const bytes = new Uint8Array(args[0]!.v as Uint8Array);
      const i = argInt(ctx, args[1]!);
      const b = argInt(ctx, args[2]!);
      if (i < 0 || i >= bytes.length) throw pgError("array_subscript_error", "index out of range", "2202E");
      bytes[i] = b & 0xff;
      return tv("bytea", bytes);
    }),
  );
  m.set(
    "overlay",
    strict("text", (ctx, args) => {
      const s = chars(argText(ctx, args[0]!));
      const placing = argText(ctx, args[1]!);
      const from = argInt(ctx, args[2]!);
      const forLen = args.length > 3 ? argInt(ctx, args[3]!) : chars(placing).length;
      if (from <= 0) throw pgError("substring_error", "negative substring length not allowed", "22011");
      const before = s.slice(0, from - 1).join("");
      const after = s.slice(from - 1 + Math.max(forLen, 0)).join("");
      return tv("text", before + placing + after);
    }),
  );
  m.set(
    "unistr",
    strict("text", (ctx, args) => {
      const s = argText(ctx, args[0]!);
      return tv("text", unistrImpl(s));
    }),
  );

  return m;
}

function byteaSubstr(bytes: Uint8Array, start: number, len?: number): Uint8Array {
  if (len !== undefined && len < 0) throw pgError("substring_error", "negative substring length not allowed", "22011");
  const from = Math.max(start, 1) - 1;
  const to = len === undefined ? bytes.length : Math.max(start + len - 1, 0);
  return bytes.slice(from, to);
}

function pad(s: string[], len: number, fill: string[], left: boolean): string {
  if (len <= 0) return "";
  if (s.length >= len) return s.slice(0, len).join("");
  if (fill.length === 0) return s.join("");
  const padLen = len - s.length;
  const padding: string[] = [];
  while (padding.length < padLen) padding.push(fill[padding.length % fill.length]!);
  return left ? padding.join("") + s.join("") : s.join("") + padding.join("");
}

function quoteLiteral(s: string): string {
  const escaped = s.replaceAll("'", "''");
  if (escaped.includes("\\")) return `E'${escaped.replaceAll("\\", "\\\\")}'`;
  return `'${escaped}'`;
}

const QUOTE_KEYWORDS = new Set([
  "all",
  "analyse",
  "analyze",
  "and",
  "any",
  "array",
  "as",
  "asc",
  "asymmetric",
  "both",
  "case",
  "cast",
  "check",
  "collate",
  "column",
  "constraint",
  "create",
  "current_catalog",
  "current_date",
  "current_role",
  "current_time",
  "current_timestamp",
  "current_user",
  "default",
  "deferrable",
  "desc",
  "distinct",
  "do",
  "else",
  "end",
  "except",
  "false",
  "fetch",
  "for",
  "foreign",
  "from",
  "grant",
  "group",
  "having",
  "in",
  "initially",
  "intersect",
  "into",
  "lateral",
  "leading",
  "limit",
  "localtime",
  "localtimestamp",
  "not",
  "null",
  "offset",
  "on",
  "only",
  "or",
  "order",
  "placing",
  "primary",
  "references",
  "returning",
  "select",
  "session_user",
  "some",
  "symmetric",
  "table",
  "then",
  "to",
  "trailing",
  "true",
  "union",
  "unique",
  "user",
  "using",
  "variadic",
  "when",
  "where",
  "window",
  "with",
]);

function formatImpl(ctx: Parameters<ScalarFn>[0], fmt: string, args: TypedValue[]): string {
  let out = "";
  let argIndex = 0;
  let i = 0;
  while (i < fmt.length) {
    const c = fmt[i]!;
    if (c !== "%") {
      out += c;
      i++;
      continue;
    }
    i++;
    if (fmt[i] === "%") {
      out += "%";
      i++;
      continue;
    }
    // %[position][flags][width]type
    const m = /^(\d+\$)?(-)?(\d+)?([sIL])/.exec(fmt.slice(i));
    if (!m) throw pgError("invalid_parameter_value", `unrecognized format() type specifier "${fmt[i]}"`);
    i += m[0].length;
    const pos = m[1] ? Number.parseInt(m[1], 10) - 1 : argIndex++;
    const arg = args[pos];
    if (arg === undefined) throw pgError("undefined_parameter", "too few arguments for format()");
    let piece: string;
    if (m[4] === "s") {
      piece = arg.v === null ? "" : argText(ctx, arg);
    } else if (m[4] === "I") {
      if (arg.v === null)
        throw pgError("null_value_not_allowed", "null values cannot be formatted as an SQL identifier", "22004");
      const s = argText(ctx, arg);
      piece = /^[a-z_][a-z0-9_$]*$/.test(s) && !QUOTE_KEYWORDS.has(s) ? s : `"${s.replaceAll('"', '""')}"`;
    } else {
      piece = arg.v === null ? "NULL" : quoteLiteral(argText(ctx, arg));
    }
    if (m[3]) {
      const width = Number.parseInt(m[3], 10);
      piece = m[2] ? piece.padEnd(width) : piece.padStart(width);
    }
    out += piece;
  }
  return out;
}

function regexpSplit(s: string, re: RegExp): string[] {
  const out: string[] = [];
  let last = 0;
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const match of s.matchAll(global)) {
    if (match[0] === "") {
      if (match.index === last && match.index !== s.length) continue;
    }
    out.push(s.slice(last, match.index));
    last = match.index! + match[0].length;
  }
  out.push(s.slice(last));
  return out;
}

function unistrImpl(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }
    if (s[i + 1] === "\\") {
      out += "\\";
      i += 2;
      continue;
    }
    const next = s[i + 1];
    if (next === "u") {
      out += String.fromCodePoint(Number.parseInt(s.slice(i + 2, i + 6), 16));
      i += 6;
    } else if (next === "U") {
      out += String.fromCodePoint(Number.parseInt(s.slice(i + 2, i + 10), 16));
      i += 10;
    } else if (next === "+") {
      out += String.fromCodePoint(Number.parseInt(s.slice(i + 2, i + 8), 16));
      i += 8;
    } else if (next !== undefined && /[0-9a-fA-F]/.test(next)) {
      out += String.fromCodePoint(Number.parseInt(s.slice(i + 1, i + 5), 16));
      i += 5;
    } else {
      throw pgError("syntax", "invalid Unicode escape");
    }
  }
  return out;
}

// --- base64 / hex / escape ---------------------------------------------------

function encodeBytes(bytes: Uint8Array, fmt: string): string {
  switch (fmt.toLowerCase()) {
    case "hex": {
      let out = "";
      for (const b of bytes) out += b.toString(16).padStart(2, "0");
      return out;
    }
    case "base64": {
      // PG wraps base64 at 76 chars
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      const b64 = btoa(bin);
      const lines: string[] = [];
      for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
      return lines.join("\n");
    }
    case "escape": {
      let out = "";
      for (const b of bytes) {
        if (b === 92) out += "\\\\";
        else if (b < 32 || b > 126) out += `\\${b.toString(8).padStart(3, "0")}`;
        else out += String.fromCharCode(b);
      }
      return out;
    }
    default:
      throw pgError("invalid_parameter_value", `unrecognized encoding: "${fmt}"`);
  }
}

function decodeBytes(s: string, fmt: string): Uint8Array {
  switch (fmt.toLowerCase()) {
    case "hex": {
      const clean = s.replaceAll(/\s/g, "");
      if (clean.length % 2 !== 0)
        throw pgError("invalid_parameter_value", "invalid hexadecimal data: odd number of digits");
      const out = new Uint8Array(clean.length / 2);
      for (let i = 0; i < out.length; i++) {
        const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
        if (Number.isNaN(byte)) throw pgError("invalid_parameter_value", `invalid hexadecimal digit`);
        out[i] = byte;
      }
      return out;
    }
    case "base64": {
      const clean = s.replaceAll(/\s/g, "");
      const bin = atob(clean);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    case "escape": {
      const out: number[] = [];
      let i = 0;
      while (i < s.length) {
        if (s[i] === "\\") {
          if (s[i + 1] === "\\") {
            out.push(92);
            i += 2;
          } else {
            out.push(Number.parseInt(s.slice(i + 1, i + 4), 8));
            i += 4;
          }
        } else {
          out.push(s.charCodeAt(i));
          i++;
        }
      }
      return new Uint8Array(out);
    }
    default:
      throw pgError("invalid_parameter_value", `unrecognized encoding: "${fmt}"`);
  }
}

/** SUBSTRING(string SIMILAR pattern ESCAPE esc): SQL regex with %" delimiters */
function substringSimilar(s: string, pattern: string, escape: string): string | null {
  // Split pattern on escape-doublequote markers into three parts
  const marker = `${escape}"`;
  const parts: string[] = [];
  let current = "";
  let i = 0;
  while (i < pattern.length) {
    if (escape !== "" && pattern.startsWith(marker, i) && escape !== '"') {
      parts.push(current);
      current = "";
      i += marker.length;
    } else if (escape !== "" && pattern[i] === escape) {
      current += pattern.slice(i, i + 2);
      i += 2;
    } else {
      current += pattern[i];
      i++;
    }
  }
  parts.push(current);
  if (parts.length === 3) {
    const re = new RegExp(
      `^${stripAnchors(similarToRegex(parts[0]!, escape || null))}(${stripAnchors(similarToRegex(parts[1]!, escape || null))})${stripAnchors(similarToRegex(parts[2]!, escape || null))}$`,
      "s",
    );
    const match = re.exec(s);
    return match ? (match[1] ?? null) : null;
  }
  const re = new RegExp(similarToRegex(pattern, escape || null), "s");
  const match = re.exec(s);
  return match ? match[0] : null;
}

function stripAnchors(re: string): string {
  return re.replace(/^\^/, "").replace(/\$$/, "");
}

// --- MD5 (public domain style implementation) --------------------------------

function md5Hex(bytes: Uint8Array): string {
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
    21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);

  const origLen = bytes.length;
  const bitLen = origLen * 8;
  const padded = new Uint8Array((((origLen + 8) >> 6) << 6) + 64);
  padded.set(bytes);
  padded[origLen] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Uint32Array(16);
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let j = 0; j < 16; j++) M[j] = dv.getUint32(chunk + j * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i]! + M[g]!) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << s[i]!) | (F >>> (32 - s[i]!)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const le = (n: number): string => {
    let out = "";
    for (let i = 0; i < 4; i++) out += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
    return out;
  };
  return le(a0) + le(b0) + le(c0) + le(d0);
}
