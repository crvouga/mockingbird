import type { CreateIndexStmt, Expr } from "../ast/nodes.ts";
import { pgError, unsupported } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import type { DatabaseState, FunctionData, TableData } from "../storage/database-state.ts";
import { canImplicitCast, castTo } from "../types/cast.ts";
import { type TypedValue, type TypeId, tv, typeDisplayName } from "../types/value.ts";

/** Marks functions installed by `CREATE EXTENSION pg_trgm` (survives PGMM). */
const PGTRGM_BODY = "pg_trgm";

/**
 * PostgreSQL `pg_trgm.word_similarity_threshold` default. The GUC is a double
 * initialized from the float32 literal `0.6f`.
 */
const WORD_SIMILARITY_THRESHOLD = Math.fround(0.6);

/** gin_trgm_ops accepts text and varchar (binary-coercible to text), not char or name. */
const GIN_TRGM_TYPES = new Set<TypeId>(["text", "varchar"]);

const WORD_CHAR = /[\p{L}\p{N}]+/gu;

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
  const existing = schema.functions.get("similarity") ?? [];
  const fn: FunctionData = {
    name: "similarity",
    schema: schema.name,
    argNames: [null, null],
    argTypes: ["text", "text"],
    argDefaults: [null, null],
    returns: "float4",
    returnsSet: false,
    returnsTable: null,
    language: "internal",
    body: null,
    rawBody: PGTRGM_BODY,
    strict: true,
    oid: state.nextOid(),
  };
  existing.push(fn);
  schema.functions.set("similarity", existing);
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

export function evalPgTrgmFunction(ctx: EngineCtx, fn: FunctionData, args: TypedValue[]): TypedValue {
  const ret = fn.returns ?? "float4";
  if (fn.strict && args.some((arg) => arg.v === null)) return tv(ret, null);
  if (fn.name !== "similarity" || args.length !== 2) {
    throw pgError("undefined_function", `function ${fn.schema}.${fn.name} is not implemented`, "42883");
  }
  const left = castTo(ctx, args[0]!, "text");
  const right = castTo(ctx, args[1]!, "text");
  if (left.v === null || right.v === null) return tv("float4", null);
  return tv("float4", trigramSimilarity(left.v as string, right.v as string));
}

/** `text <% text` — word similarity at the default threshold. Absent until pg_trgm is installed. */
export function evalTrgmWordSimilar(ctx: EngineCtx, left: TypedValue, right: TypedValue): TypedValue {
  const missing = (): never => {
    throw pgError(
      "undefined_function",
      `operator does not exist: ${typeDisplayName(left.t)} <% ${typeDisplayName(right.t)}`,
    );
  };
  if (!pgTrgmInstalled(ctx.state)) missing();
  if (!canImplicitCast(left.t, "text") || !canImplicitCast(right.t, "text")) missing();
  const a = castTo(ctx, left, "text");
  const b = castTo(ctx, right, "text");
  if (a.v === null || b.v === null) return tv("bool", null);
  const score = wordSimilarity(a.v as string, b.v as string);
  return tv("bool", score >= WORD_SIMILARITY_THRESHOLD);
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

/** `|intersection| / |union|` as float4. Either empty trigram set yields 0. */
export function trigramSimilarity(left: string, right: string): number {
  const a = uniqueSorted(orderedTrigrams(left));
  const b = uniqueSorted(orderedTrigrams(right));
  if (a.length === 0 || b.length === 0) return 0;
  let i = 0;
  let j = 0;
  let count = 0;
  while (i < a.length && j < b.length) {
    const cmp = a[i]! < b[j]! ? -1 : a[i]! > b[j]! ? 1 : 0;
    if (cmp < 0) i++;
    else if (cmp > 0) j++;
    else {
      count++;
      i++;
      j++;
    }
  }
  return calcSml(count, a.length, b.length);
}

/**
 * Greatest similarity between the trigram set of `pattern` and any continuous
 * extent of the ordered trigrams of `haystack` (PostgreSQL `word_similarity`).
 */
export function wordSimilarity(pattern: string, haystack: string): number {
  const trg1 = orderedTrigrams(pattern);
  const trg2 = orderedTrigrams(haystack);
  const len1 = trg1.length;
  const len2 = trg2.length;
  if (len1 === 0 || len2 === 0) return 0;

  const positional: Array<{ trg: string; index: number }> = [];
  for (let i = 0; i < len1; i++) positional.push({ trg: trg1[i]!, index: -1 });
  for (let i = 0; i < len2; i++) positional.push({ trg: trg2[i]!, index: i });
  positional.sort((x, y) => (x.trg < y.trg ? -1 : x.trg > y.trg ? 1 : x.index - y.index));

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
  if (found[group]) ulen1++;
  return iterateWordSimilarity(trg2indexes, found, ulen1, len2);
}

/**
 * Ordered, non-unique trigrams. Each alphanumeric word is lowercased, padded
 * with two leading spaces and one trailing space, then sliced into triples.
 * That padding is what `show_trgm('Cat')` prints as `{"  c"," ca",cat,"at "}`.
 */
function orderedTrigrams(input: string): string[] {
  const out: string[] = [];
  for (const match of input.matchAll(WORD_CHAR)) {
    const padded = `  ${match[0].toLowerCase()} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.push(padded.slice(i, i + 3));
  }
  return out;
}

function uniqueSorted(trigrams: string[]): string[] {
  return [...new Set(trigrams)].sort();
}

function calcSml(count: number, len1: number, len2: number): number {
  const denom = len1 + len2 - count;
  if (denom <= 0) return 0;
  return Math.fround(count / denom);
}

function iterateWordSimilarity(trg2indexes: number[], found: boolean[], ulen1: number, len2: number): number {
  const lastpos = new Array<number>(found.length).fill(-1);
  let ulen2 = 0;
  let count = 0;
  let lower = -1;
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
    if (!found[trgindex]) continue;

    if (lower === -1) {
      lower = i;
      ulen2 = 1;
    }
    let smlrCur = calcSml(count, ulen1, ulen2);
    let tmpCount = count;
    let tmpUlen2 = ulen2;
    const prevLower = lower;
    for (let tmpLower = lower; tmpLower <= i; tmpLower++) {
      const smlrTmp = calcSml(tmpCount, ulen1, tmpUlen2);
      if (smlrTmp > smlrCur) {
        smlrCur = smlrTmp;
        ulen2 = tmpUlen2;
        lower = tmpLower;
        count = tmpCount;
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
