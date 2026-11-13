import type { CreateIndexStmt, Expr } from "../ast/nodes.ts";
import { pgError, unsupported } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import type { DatabaseState, FunctionData, TableData } from "../storage/database-state.ts";
import { type GucDef, registerExtensionGuc, setConfiguration } from "../storage/guc-catalog.ts";
import { canImplicitCast, castTo } from "../types/cast.ts";
import { float4Text, makeArray, type TypedValue, type TypeId, tv, typeDisplayName } from "../types/value.ts";

/** Marks functions installed by `CREATE EXTENSION pg_trgm` (survives PGMM). */
const PGTRGM_BODY = "pg_trgm";

/** gin_trgm_ops accepts text and varchar (binary-coercible to text), not char or name. */
const GIN_TRGM_TYPES = new Set<TypeId>(["text", "varchar"]);

const WORD_CHAR = /[\p{L}\p{N}]+/gu;

// --- settings ---------------------------------------------------------------------------------

const SIMILARITY_THRESHOLD = "pg_trgm.similarity_threshold";
const WORD_SIMILARITY_THRESHOLD = "pg_trgm.word_similarity_threshold";
const STRICT_WORD_SIMILARITY_THRESHOLD = "pg_trgm.strict_word_similarity_threshold";

/**
 * `DefineCustomRealVariable` defaults: doubles initialized from float literals (`0.3f`), which
 * is what the operators compare against until a value is set.
 */
const THRESHOLD_DEFAULTS: Readonly<Record<string, number>> = {
  [SIMILARITY_THRESHOLD]: Math.fround(0.3),
  [WORD_SIMILARITY_THRESHOLD]: Math.fround(0.6),
  [STRICT_WORD_SIMILARITY_THRESHOLD]: Math.fround(0.5),
};

function thresholdDef(name: string, shown: string, operator: string): GucDef {
  return {
    name,
    vartype: "real",
    context: "user",
    unit: null,
    setting: shown,
    bootVal: shown,
    category: "Customized Options",
    shortDesc: `Sets the threshold used by the ${operator} operator.`,
    min: "0",
    max: "1",
    enumvals: null,
    source: "default",
  };
}

registerExtensionGuc(thresholdDef(SIMILARITY_THRESHOLD, "0.3", "%"), pgTrgmInstalled);
registerExtensionGuc(thresholdDef(WORD_SIMILARITY_THRESHOLD, "0.6", "<%"), pgTrgmInstalled);
registerExtensionGuc(thresholdDef(STRICT_WORD_SIMILARITY_THRESHOLD, "0.5", "<<%"), pgTrgmInstalled);

/**
 * The threshold a pg_trgm setting holds. Values are kept as SHOW prints them (`%g`), so a value
 * set with more than six significant digits compares at that rounding. (Comparing a float4
 * score against `0.3` or against the float default `0.3f` gives the same answer.)
 */
function threshold(state: DatabaseState, name: string): number {
  const shown = state.getSetting(name);
  const value = shown === undefined || shown === "" ? Number.NaN : Number(shown);
  return Number.isFinite(value) ? value : THRESHOLD_DEFAULTS[name]!;
}

// --- installation -----------------------------------------------------------------------------

interface MemberSpec {
  readonly args: readonly TypeId[];
  readonly returns: TypeId;
  readonly volatility?: "immutable" | "stable";
}

const TT: readonly TypeId[] = ["text", "text"];

/** The SQL-callable functions `CREATE EXTENSION pg_trgm` adds (index support functions aside). */
const MEMBERS: Readonly<Record<string, MemberSpec>> = {
  set_limit: { args: ["float4"], returns: "float4" },
  show_limit: { args: [], returns: "float4", volatility: "stable" },
  show_trgm: { args: ["text"], returns: "text[]", volatility: "immutable" },
  similarity: { args: TT, returns: "float4", volatility: "immutable" },
  similarity_op: { args: TT, returns: "bool", volatility: "stable" },
  similarity_dist: { args: TT, returns: "float4", volatility: "immutable" },
  word_similarity: { args: TT, returns: "float4", volatility: "immutable" },
  word_similarity_op: { args: TT, returns: "bool", volatility: "stable" },
  word_similarity_commutator_op: { args: TT, returns: "bool", volatility: "stable" },
  word_similarity_dist_op: { args: TT, returns: "float4", volatility: "immutable" },
  word_similarity_dist_commutator_op: { args: TT, returns: "float4", volatility: "immutable" },
  strict_word_similarity: { args: TT, returns: "float4", volatility: "immutable" },
  strict_word_similarity_op: { args: TT, returns: "bool", volatility: "stable" },
  strict_word_similarity_commutator_op: { args: TT, returns: "bool", volatility: "stable" },
  strict_word_similarity_dist_op: { args: TT, returns: "float4", volatility: "immutable" },
  strict_word_similarity_dist_commutator_op: { args: TT, returns: "float4", volatility: "immutable" },
};

export function pgTrgmSchema(state: DatabaseState): string | null {
  for (const schema of state.schemas.values()) {
    for (const fns of schema.functions.values()) {
      if (fns.some((fn) => fn.language === "internal" && fn.rawBody === PGTRGM_BODY)) return schema.name;
    }
  }
  return null;
}

export function pgTrgmInstalled(state: DatabaseState): boolean {
  return pgTrgmSchema(state) !== null;
}

export function installPgTrgm(state: DatabaseState, schemaName: string): void {
  const schema = state.getSchema(schemaName);
  for (const [name, spec] of Object.entries(MEMBERS)) {
    const fn: FunctionData = {
      name,
      schema: schema.name,
      argNames: spec.args.map(() => null),
      argTypes: [...spec.args],
      argDefaults: spec.args.map(() => null),
      returns: spec.returns,
      returnsSet: false,
      returnsTable: null,
      language: "internal",
      body: null,
      rawBody: PGTRGM_BODY,
      strict: true,
      oid: state.nextOid(),
      ...(spec.volatility ? { volatility: spec.volatility } : {}),
    };
    schema.functions.set(name, [...(schema.functions.get(name) ?? []), fn]);
  }
}

export function uninstallPgTrgm(state: DatabaseState): boolean {
  let removed = false;
  for (const schema of state.schemas.values()) {
    for (const [name, fns] of [...schema.functions.entries()]) {
      const keep = fns.filter((fn) => fn.language !== "internal" || fn.rawBody !== PGTRGM_BODY);
      if (keep.length === fns.length) continue;
      removed = true;
      if (keep.length === 0) schema.functions.delete(name);
      else schema.functions.set(name, keep);
    }
  }
  return removed;
}

// --- functions and operators ------------------------------------------------------------------

type TrgmKind = "similarity" | "word" | "strict";

/** Each operator: the measure it uses, whether it swaps its operands, and distance (1 - x) or a threshold test. */
const OPERATORS: Readonly<Record<string, { kind: TrgmKind; swap: boolean; dist: boolean }>> = {
  "%": { kind: "similarity", swap: false, dist: false },
  "<->": { kind: "similarity", swap: false, dist: true },
  "<%": { kind: "word", swap: false, dist: false },
  "%>": { kind: "word", swap: true, dist: false },
  "<<->": { kind: "word", swap: false, dist: true },
  "<->>": { kind: "word", swap: true, dist: true },
  "<<%": { kind: "strict", swap: false, dist: false },
  "%>>": { kind: "strict", swap: true, dist: false },
  "<<<->": { kind: "strict", swap: false, dist: true },
  "<->>>": { kind: "strict", swap: true, dist: true },
};

/** Operator-implementing functions, by name, as the operators above. */
const OPERATOR_FUNCTIONS: Readonly<Record<string, string>> = {
  similarity_op: "%",
  similarity_dist: "<->",
  word_similarity_op: "<%",
  word_similarity_commutator_op: "%>",
  word_similarity_dist_op: "<<->",
  word_similarity_dist_commutator_op: "<->>",
  strict_word_similarity_op: "<<%",
  strict_word_similarity_commutator_op: "%>>",
  strict_word_similarity_dist_op: "<<<->",
  strict_word_similarity_dist_commutator_op: "<->>>",
};

const THRESHOLD_OF: Readonly<Record<TrgmKind, string>> = {
  similarity: SIMILARITY_THRESHOLD,
  word: WORD_SIMILARITY_THRESHOLD,
  strict: STRICT_WORD_SIMILARITY_THRESHOLD,
};

function measure(kind: TrgmKind, a: string, b: string): number {
  if (kind === "similarity") return trigramSimilarity(a, b);
  return wordSimilarity(a, b, kind === "strict");
}

function applyOperator(state: DatabaseState, op: string, a: string, b: string): TypedValue {
  const spec = OPERATORS[op]!;
  const [x, y] = spec.swap ? [b, a] : [a, b];
  const score = measure(spec.kind, x, y);
  if (spec.dist) return tv("float4", Math.fround(1 - score));
  return tv("bool", score >= threshold(state, THRESHOLD_OF[spec.kind]));
}

export function evalPgTrgmFunction(ctx: EngineCtx, fn: FunctionData, args: TypedValue[]): TypedValue {
  const ret = fn.returns ?? "float4";
  if (fn.strict && args.some((arg) => arg.v === null)) return tv(ret, null);
  const text = (i: number): string => castTo(ctx, args[i]!, "text").v as string;
  const operator = OPERATOR_FUNCTIONS[fn.name];
  if (operator !== undefined) return applyOperator(ctx.state, operator, text(0), text(1));
  switch (fn.name) {
    case "similarity":
      return tv("float4", trigramSimilarity(text(0), text(1)));
    case "word_similarity":
      return tv("float4", wordSimilarity(text(0), text(1), false));
    case "strict_word_similarity":
      return tv("float4", wordSimilarity(text(0), text(1), true));
    case "show_trgm":
      return tv("text[]", makeArray("text", showTrgm(text(0))));
    case "show_limit":
      return tv("float4", Math.fround(threshold(ctx.state, SIMILARITY_THRESHOLD)));
    case "set_limit": {
      const limit = castTo(ctx, args[0]!, "float4").v as number;
      setConfiguration(ctx.state, SIMILARITY_THRESHOLD, float4Text(limit), false);
      return tv("float4", Math.fround(threshold(ctx.state, SIMILARITY_THRESHOLD)));
    }
    default:
      throw pgError("undefined_function", `function ${fn.schema}.${fn.name} is not implemented`, "42883");
  }
}

const isTrgmOperand = (t: TypeId): boolean => t === "unknown" || canImplicitCast(t, "text");

/**
 * pg_trgm's `text OP text` operators. `%` and `<->` are shared with other types (integer modulo,
 * geometric and vector distance), so for them a non-text operand or a missing extension yields
 * `null` and leaves the operator to its other implementations; the rest exist only in pg_trgm.
 */
export function evalTrgmBinary(ctx: EngineCtx, op: string, left: TypedValue, right: TypedValue): TypedValue | null {
  if (OPERATORS[op] === undefined) return null;
  const shared = op === "%" || op === "<->";
  // `unknown % integer` stays integer modulo; two unknowns resolve to text % text
  if (!pgTrgmInstalled(ctx.state) || !isTrgmOperand(left.t) || !isTrgmOperand(right.t)) {
    if (shared) return null;
    throw pgError(
      "undefined_function",
      `operator does not exist: ${typeDisplayName(left.t)} ${op} ${typeDisplayName(right.t)}`,
    );
  }
  const a = castTo(ctx, left, "text");
  const b = castTo(ctx, right, "text");
  if (a.v === null || b.v === null) return tv(OPERATORS[op]!.dist ? "float4" : "bool", null);
  return applyOperator(ctx.state, op, a.v as string, b.v as string);
}

/**
 * Reject `gin_trgm_ops` unless pg_trgm is installed for access method gin.
 * A single text/varchar column or expression is stored as an ordinary non-unique index:
 * lookup speed is not modelled.
 */
export function assertGinTrgmIndex(
  state: DatabaseState,
  table: TableData,
  stmt: CreateIndexStmt,
  expressionType: (expr: Expr) => TypeId,
): void {
  const trgmCols = stmt.columns.filter((col) => isGinTrgmOpclass(col.opclass));
  if (trgmCols.length === 0) return;
  if (trgmCols.length !== stmt.columns.length || stmt.columns.length !== 1) {
    throw unsupported("multicolumn gin_trgm_ops");
  }
  const method = stmt.using ?? "btree";
  const col = trgmCols[0]!;
  const opclass = col.opclass!;
  const label = opclass.join(".");
  if (method !== "gin" || !opclassVisible(state, opclass)) {
    throw pgError(
      "undefined_object",
      `operator class "${label}" does not exist for access method "${method}"`,
      "42704",
    );
  }
  if (stmt.unique) {
    throw pgError("feature_not_supported", `access method "gin" does not support unique indexes`, "0A000");
  }
  const typeId =
    col.expr.type === "colref" && col.expr.parts.length === 1
      ? table.columns[table.columnIndex(col.expr.parts[0]!)]!.type.id
      : expressionType(col.expr);
  if (!GIN_TRGM_TYPES.has(typeId)) {
    throw pgError(
      "datatype_mismatch",
      `operator class "${label}" does not accept data type ${typeDisplayName(typeId)}`,
      "42804",
    );
  }
}

function isGinTrgmOpclass(opclass: string[] | null): boolean {
  return opclass !== null && opclass[opclass.length - 1] === "gin_trgm_ops";
}

function opclassVisible(state: DatabaseState, opclass: string[]): boolean {
  const schema = pgTrgmSchema(state);
  if (schema === null || opclass[opclass.length - 1] !== "gin_trgm_ops") return false;
  if (opclass.length === 1) return state.effectiveSearchPath().includes(schema);
  if (opclass.length === 2) return opclass[0] === schema;
  return false;
}

// --- trigrams ---------------------------------------------------------------------------------

/**
 * A trigram is three bytes, kept here as a string of three char codes 0..255: three single-byte
 * characters as themselves, anything wider as three bytes of the legacy CRC-32 of its UTF-8
 * (`compact_trigram`).
 */
type Trgm = string;

const TRGM_BOUND_LEFT = 1;
const TRGM_BOUND_RIGHT = 2;

const utf8 = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** PostgreSQL's pre-9.5 "legacy" CRC-32: the reflected table driven by non-reflected code. */
function legacyCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]! ^ (crc << 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function compactTrigram(chars: string[]): Trgm {
  const joined = chars.join("");
  if (joined.length === 3 && chars.every((c) => c.charCodeAt(0) < 0x80)) return joined;
  // the first three bytes of the crc as it sits in (little-endian) memory
  const crc = legacyCrc32(utf8.encode(joined));
  return String.fromCharCode(crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff);
}

/**
 * Ordered, non-unique trigrams, and whether each starts or ends a word. Each alphanumeric
 * word is lowercased, padded with two leading spaces and one trailing space, then sliced
 * into triples: `show_trgm('Cat')` prints `{"  c"," ca",cat,"at "}`.
 */
function orderedTrigrams(input: string): { trgms: Trgm[]; bounds: number[] } {
  const trgms: Trgm[] = [];
  const bounds: number[] = [];
  for (const match of input.matchAll(WORD_CHAR)) {
    const chars = Array.from(`  ${match[0].toLowerCase()} `);
    const first = trgms.length;
    for (let i = 0; i + 3 <= chars.length; i++) {
      trgms.push(compactTrigram(chars.slice(i, i + 3)));
      bounds.push(0);
    }
    bounds[first] = bounds[first]! | TRGM_BOUND_LEFT;
    bounds[trgms.length - 1] = bounds[trgms.length - 1]! | TRGM_BOUND_RIGHT;
  }
  return { trgms, bounds };
}

/** CMPTRGM with signed chars (the default char signedness of x86 and WebAssembly builds). */
function compareTrgm(a: Trgm, b: Trgm): number {
  for (let i = 0; i < 3; i++) {
    const x = a.charCodeAt(i) ^ 0x80;
    const y = b.charCodeAt(i) ^ 0x80;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function uniqueSorted(trgms: Trgm[]): Trgm[] {
  return [...new Set(trgms)].sort(compareTrgm);
}

const isPrintable = (code: number): boolean =>
  code === 0x20 || (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

/** `show_trgm`: sorted unique trigrams, a hashed one as `0x` and six hex digits. */
export function showTrgm(input: string): string[] {
  return uniqueSorted(orderedTrigrams(input).trgms).map((trgm) => {
    const codes = [0, 1, 2].map((i) => trgm.charCodeAt(i));
    if (codes.every(isPrintable)) return trgm;
    const value = (codes[0]! << 16) | (codes[1]! << 8) | codes[2]!;
    return `0x${value.toString(16).padStart(6, "0")}`;
  });
}

/** `|intersection| / |union|` as float4. Either empty trigram set yields 0. */
export function trigramSimilarity(left: string, right: string): number {
  const a = new Set(orderedTrigrams(left).trgms);
  const b = new Set(orderedTrigrams(right).trgms);
  if (a.size === 0 || b.size === 0) return 0;
  let count = 0;
  for (const trgm of a) if (b.has(trgm)) count++;
  return calcSml(count, a.size, b.size);
}

/**
 * Greatest similarity between the trigram set of `pattern` and any continuous extent of the
 * ordered trigrams of `haystack` (PostgreSQL `calc_word_similarity`). Strict mode only
 * considers extents that start and end on word bounds.
 */
export function wordSimilarity(pattern: string, haystack: string, strict = false): number {
  const trg1 = orderedTrigrams(pattern).trgms;
  const { trgms: trg2, bounds } = orderedTrigrams(haystack);
  const len1 = trg1.length;
  const len2 = trg2.length;

  const positional: Array<{ trg: Trgm; index: number }> = [];
  for (let i = 0; i < len1; i++) positional.push({ trg: trg1[i]!, index: -1 });
  for (let i = 0; i < len2; i++) positional.push({ trg: trg2[i]!, index: i });
  positional.sort((x, y) => compareTrgm(x.trg, y.trg) || x.index - y.index);

  const len = len1 + len2;
  const trg2indexes = new Array<number>(len2);
  const found = new Array<boolean>(len).fill(false);
  let ulen1 = 0;
  let group = 0;
  for (let i = 0; i < len; i++) {
    if (i > 0 && positional[i - 1]!.trg !== positional[i]!.trg) {
      if (found[group]) ulen1++;
      group++;
    }
    const index = positional[i]!.index;
    if (index >= 0) trg2indexes[index] = group;
    else found[group] = true;
  }
  if (len > 0 && found[group]) ulen1++;
  return iterateWordSimilarity(trg2indexes, found, ulen1, len2, strict, bounds);
}

function calcSml(count: number, len1: number, len2: number): number {
  if (len1 + len2 - count <= 0) return 0;
  return Math.fround(Math.fround(count) / Math.fround(len1 + len2 - count));
}

function iterateWordSimilarity(
  trg2indexes: number[],
  found: boolean[],
  ulen1: number,
  len2: number,
  strict: boolean,
  bounds: number[],
): number {
  const lastpos = new Array<number>(found.length).fill(-1);
  let ulen2 = 0;
  let count = 0;
  let lower = strict ? 0 : -1;
  let smlrMax = 0;

  for (let i = 0; i < len2; i++) {
    const trgindex = trg2indexes[i]!;
    if (lower >= 0 || found[trgindex]) {
      if (lastpos[trgindex]! < 0) {
        ulen2++;
        if (found[trgindex]) count++;
      }
      lastpos[trgindex] = i;
    }
    if (!(strict ? (bounds[i]! & TRGM_BOUND_RIGHT) !== 0 : found[trgindex])) continue;

    const upper = i;
    if (lower === -1) {
      lower = i;
      ulen2 = 1;
    }
    let smlrCur = calcSml(count, ulen1, ulen2);
    let tmpCount = count;
    let tmpUlen2 = ulen2;
    const prevLower = lower;
    for (let tmpLower = lower; tmpLower <= upper; tmpLower++) {
      if (!strict || (bounds[tmpLower]! & TRGM_BOUND_LEFT) !== 0) {
        const smlrTmp = calcSml(tmpCount, ulen1, tmpUlen2);
        if (smlrTmp > smlrCur) {
          smlrCur = smlrTmp;
          ulen2 = tmpUlen2;
          lower = tmpLower;
          count = tmpCount;
        }
      }
      const tmpTrgindex = trg2indexes[tmpLower]!;
      if (lastpos[tmpTrgindex] === tmpLower) {
        tmpUlen2--;
        if (found[tmpTrgindex]) tmpCount--;
      }
    }
    if (smlrCur > smlrMax) smlrMax = smlrCur;
    for (let tmpLower = prevLower; tmpLower < lower; tmpLower++) {
      const tmpTrgindex = trg2indexes[tmpLower]!;
      if (lastpos[tmpTrgindex] === tmpLower) lastpos[tmpTrgindex] = -1;
    }
  }
  return smlrMax;
}
