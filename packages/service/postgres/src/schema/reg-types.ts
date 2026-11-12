import type { SelectStmt, TypeName } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import { getAggregateFactories } from "../functions/aggregates.ts";
import { getScalarFunctions } from "../functions/scalar.ts";
import { getSrfFunctions } from "../functions/srf.ts";
import { WINDOW_FUNCTION_NAMES } from "../functions/window.ts";
import { parse } from "../parser/index.ts";
import { quoteIdentifier } from "../sql/keywords.ts";
import type { DatabaseState, FunctionData } from "../storage/database-state.ts";
import { parseRelationInput } from "../types/regnamespace.ts";
import { resolveTypeName } from "../types/resolve.ts";
import {
  ARRAY_OIDS,
  arrayElemType,
  enumTypeName,
  isArrayType,
  isCompositeType,
  isEnumType,
  TYPE_OIDS,
  type TypeId,
  typeDisplayName,
} from "../types/value.ts";

/**
 * `regtype` and `regproc`: names that stand for a pg_type / pg_proc row. The engine keeps their
 * values as the name `regtypeout` / `regprocout` prints; these resolve input text to that name and
 * convert between it and the oid the catalogs list.
 */

/** Pseudo-types, with PostgreSQL's oids. */
const PSEUDO_TYPES: ReadonlyMap<string, number> = new Map([
  ["any", 2276],
  ["anyarray", 2277],
  ["anycompatible", 5077],
  ["anycompatiblearray", 5078],
  ["anyelement", 2283],
  ["anyenum", 3500],
  ["anynonarray", 2776],
  ["anyrange", 3831],
  ["cstring", 2275],
  ["event_trigger", 3838],
  ["fdw_handler", 3115],
  ["index_am_handler", 325],
  ["internal", 2281],
  ["language_handler", 2280],
  ["record", 2249],
  ["table_am_handler", 269],
  ["trigger", 2279],
  ["tsm_handler", 3310],
  ["void", 2278],
]);

// --- builtin functions ---------------------------------------------------------------------

export interface BuiltinProc {
  readonly oid: number;
  readonly name: string;
  readonly kind: "f" | "a" | "w";
  readonly retset: boolean;
}

let builtins: BuiltinProc[] | null = null;

/** The engine's own functions as pg_proc lists them, each name once per kind, with stable oids. */
export function builtinProcs(): readonly BuiltinProc[] {
  if (builtins) return builtins;
  const out: BuiltinProc[] = [];
  let oid = 1000;
  const seen = new Set<string>();
  const push = (name: string, kind: BuiltinProc["kind"], retset: boolean) => {
    out.push({ oid: oid++, name, kind, retset });
  };
  for (const name of getScalarFunctions().keys()) {
    if (seen.has(name)) continue;
    seen.add(name);
    push(name, "f", false);
  }
  for (const name of Object.keys(getAggregateFactories())) {
    if (seen.has(`agg:${name}`)) continue;
    seen.add(`agg:${name}`);
    push(name, "a", false);
  }
  for (const name of WINDOW_FUNCTION_NAMES) push(name, "w", false);
  for (const name of getSrfFunctions().keys()) push(name, "f", true);
  builtins = out;
  return out;
}

function* userFunctions(state: DatabaseState): Generator<FunctionData> {
  for (const schema of state.schemas.values()) {
    for (const overloads of schema.functions.values()) yield* overloads;
  }
}

/** The user function with this oid. */
export function findFunctionByOid(state: DatabaseState, oid: number): FunctionData | null {
  for (const f of userFunctions(state)) if (f.oid === oid) return f;
  return null;
}

// --- regtype -------------------------------------------------------------------------------

function parseTypeText(text: string): TypeName {
  let stmt: SelectStmt | undefined;
  try {
    stmt = parse(`SELECT NULL::${text}`)[0] as SelectStmt | undefined;
  } catch {
    throw pgError("syntax", `invalid type name "${text}"`, "42601");
  }
  const body = stmt?.body as { targets?: Array<{ expr: { type: string; target?: TypeName } }> } | undefined;
  const expr = body?.targets?.[0]?.expr;
  if (expr?.type !== "cast" || !expr.target) throw pgError("syntax", `invalid type name "${text}"`, "42601");
  return expr.target;
}

/** regtypeout's spelling: user types are schema-qualified unless the search path finds them. */
function visibleUserType(state: DatabaseState, schema: string, name: string, kind: "enum" | "domain"): string {
  const visible = kind === "enum" ? state.findEnum([name]) : state.findDomain([name]);
  return visible?.schema === schema ? quoteIdentifier(name) : `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

function typeIdName(state: DatabaseState, t: TypeId): string {
  if (isArrayType(t)) return `${typeIdName(state, arrayElemType(t))}[]`;
  if (isEnumType(t)) {
    const qualified = enumTypeName(t);
    const dot = qualified.indexOf(".");
    return visibleUserType(state, qualified.slice(0, dot), qualified.slice(dot + 1), "enum");
  }
  return typeDisplayName(t);
}

/** regtypein: the type `text` names, as regtypeout prints it (42704 when there is none). */
export function regtypeIn(state: DatabaseState, text: string): string {
  const trimmed = text.trim();
  if (trimmed === "-") return "-";
  if (/^\d+$/.test(trimmed)) return regtypeName(state, Number(trimmed)) ?? trimmed;
  const bare = trimmed.toLowerCase().replace(/^pg_catalog\./, "");
  if (PSEUDO_TYPES.has(bare)) return bare;
  const tn = parseTypeText(trimmed);
  const resolved = resolveTypeName(state, tn);
  if (resolved.domain) {
    const dot = resolved.domain.indexOf(".");
    return visibleUserType(state, resolved.domain.slice(0, dot), resolved.domain.slice(dot + 1), "domain");
  }
  return typeIdName(state, resolved.column.id);
}

/** The oid of the type a regtype value names, or null. */
export function regtypeOid(state: DatabaseState, name: string): number | null {
  if (name === "-") return 0;
  const pseudo = PSEUDO_TYPES.get(name);
  if (pseudo !== undefined) return pseudo;
  let resolved: ReturnType<typeof resolveTypeName>;
  try {
    resolved = resolveTypeName(state, parseTypeText(name));
  } catch {
    return null;
  }
  if (resolved.domain) {
    const dot = resolved.domain.indexOf(".");
    return state.schemas.get(resolved.domain.slice(0, dot))?.domains.get(resolved.domain.slice(dot + 1))?.oid ?? null;
  }
  const id = resolved.column.id;
  if (isEnumType(id)) return state.findEnumByKey(id.slice(5))?.oid ?? null;
  if (isCompositeType(id)) return state.catalogExt.composites.get(id.slice(5))?.oid ?? null;
  if (isArrayType(id) && isCompositeType(arrayElemType(id))) {
    return state.catalogExt.composites.get(arrayElemType(id).slice(5))?.arrayOid ?? null;
  }
  if (isArrayType(id)) return ARRAY_OIDS[arrayElemType(id)] ?? null;
  return TYPE_OIDS[id] ?? null;
}

/** regtypeout for an oid, or null when no type has it. */
export function regtypeName(state: DatabaseState, oid: number): string | null {
  if (oid === 0) return "-";
  for (const [name, pseudo] of PSEUDO_TYPES) if (pseudo === oid) return name;
  for (const [name, o] of Object.entries(TYPE_OIDS)) if (o === oid) return typeDisplayName(name);
  for (const [name, o] of Object.entries(ARRAY_OIDS)) if (o === oid) return `${typeDisplayName(name)}[]`;
  for (const schema of state.schemas.values()) {
    for (const e of schema.enums.values()) if (e.oid === oid) return visibleUserType(state, e.schema, e.name, "enum");
    for (const d of schema.domains.values()) {
      if (d.oid === oid) return visibleUserType(state, d.schema, d.name, "domain");
    }
  }
  for (const c of state.catalogExt.composites.values()) {
    if (c.oid === oid) return c.name;
    if (c.arrayOid === oid) return `${c.name}[]`;
  }
  return null;
}

/** The oid of a type the engine names by TypeId (0 when it has none). */
export function typeIdOid(state: DatabaseState, t: TypeId): number {
  const pseudo = PSEUDO_TYPES.get(t);
  if (pseudo !== undefined) return pseudo;
  if (isEnumType(t)) return state.findEnumByKey(t.slice(5))?.oid ?? 0;
  if (isCompositeType(t)) return state.catalogExt.composites.get(t.slice(5))?.oid ?? 0;
  if (isArrayType(t) && isCompositeType(arrayElemType(t))) {
    return state.catalogExt.composites.get(arrayElemType(t).slice(5))?.arrayOid ?? 0;
  }
  if (isArrayType(t)) return ARRAY_OIDS[arrayElemType(t)] ?? 0;
  return TYPE_OIDS[t] ?? 0;
}

/** The oid of a function's declared return type: `record` for OUT parameters and RETURNS TABLE. */
export function returnTypeOid(state: DatabaseState, f: FunctionData): number {
  if (f.returnsTable || f.outArgs?.length) return PSEUDO_TYPES.get("record")!;
  if (f.returns === null) return PSEUDO_TYPES.get("void")!;
  return typeIdOid(state, f.returns);
}

// --- regproc -------------------------------------------------------------------------------

function builtinNamed(name: string): BuiltinProc | undefined {
  return builtinProcs().find((p) => p.name === name);
}

/** regprocin: the one function `text` names, as regprocout prints it. */
export function regprocIn(state: DatabaseState, text: string): string {
  const trimmed = text.trim();
  if (trimmed === "-") return "-";
  if (/^\d+$/.test(trimmed)) return regprocName(state, Number(trimmed)) ?? trimmed;
  const parsed = parseRelationInput(trimmed);
  if ("oid" in parsed) return regprocName(state, parsed.oid) ?? trimmed;
  const parts = parsed.parts;
  const name = parts.at(-1)!;
  const user = state.findFunctions(parts);
  const builtin = parts.length === 1 || parts[0] === "pg_catalog" ? builtinNamed(name) : undefined;
  if (user.length === 0 && !builtin) {
    throw pgError("undefined_function", `function "${trimmed}" does not exist`, "42883");
  }
  if (user.length > 1) throw pgError("ambiguous_function", `more than one function named "${trimmed}"`, "42725");
  const found = user[0];
  if (!found) return quoteIdentifier(name);
  return procVisibleName(state, found);
}

function procVisibleName(state: DatabaseState, f: FunctionData): string {
  const visible = state.findFunctions([f.name])[0];
  return visible?.schema === f.schema || f.schema === "pg_catalog"
    ? quoteIdentifier(f.name)
    : `${quoteIdentifier(f.schema)}.${quoteIdentifier(f.name)}`;
}

/** The oid of the function a regproc value names, or null. */
export function regprocOid(state: DatabaseState, name: string): number | null {
  if (name === "-") return 0;
  let parts: string[];
  try {
    const parsed = parseRelationInput(name);
    if ("oid" in parsed) return parsed.oid;
    parts = parsed.parts;
  } catch {
    return null;
  }
  const user = state.findFunctions(parts)[0];
  if (user) return user.oid;
  return builtinNamed(parts.at(-1)!)?.oid ?? null;
}

/** regprocout for an oid, or null when no function has it. */
export function regprocName(state: DatabaseState, oid: number): string | null {
  if (oid === 0) return "-";
  const user = findFunctionByOid(state, oid);
  if (user) return procVisibleName(state, user);
  const builtin = builtinProcs().find((p) => p.oid === oid);
  return builtin ? quoteIdentifier(builtin.name) : null;
}

// --- format_type ---------------------------------------------------------------------------

const INTERVAL_FIELDS: ReadonlyArray<readonly [mask: number, text: string]> = [
  [1 << 2, "year"],
  [1 << 1, "month"],
  [1 << 3, "day"],
  [1 << 10, "hour"],
  [1 << 11, "minute"],
  [1 << 12, "second"],
];

function intervalModifier(typmod: number): string {
  const range = (typmod >>> 16) & 0x7fff;
  const precision = typmod & 0xffff;
  let out = "";
  if (range !== 0x7fff) {
    const fields = INTERVAL_FIELDS.filter(([mask]) => (range & mask) !== 0).map(([, text]) => text);
    out = fields.length === 1 ? ` ${fields[0]}` : ` ${fields[0]} to ${fields.at(-1)}`;
  }
  if (precision !== 0xffff) out += `(${precision})`;
  return out;
}

/** The name with its modifier, as format_type(oid, typmod) prints one type (no array suffix). */
function formatScalar(state: DatabaseState, oid: number, typmod: number | null): string {
  if (oid === 1042 && typmod !== null && typmod < 0) return "bpchar";
  const name = regtypeName(state, oid);
  if (name === null) return "???";
  if (typmod === null || typmod < 0) return name;
  switch (oid) {
    case 1043:
      return `character varying(${typmod - 4})`;
    case 1042:
      return `character(${typmod - 4})`;
    case 1700: {
      const mod = typmod - 4;
      const scale = ((mod & 0x7ff) ^ 1024) - 1024;
      return `numeric(${(mod >> 16) & 0xffff},${scale})`;
    }
    case 1560:
      return `bit(${typmod})`;
    case 1562:
      return `bit varying(${typmod})`;
    case 1114:
      return `timestamp(${typmod}) without time zone`;
    case 1184:
      return `timestamp(${typmod}) with time zone`;
    case 1083:
      return `time(${typmod}) without time zone`;
    case 1266:
      return `time(${typmod}) with time zone`;
    case 1186:
      return `interval${intervalModifier(typmod)}`;
    default:
      return name;
  }
}

/** format_type(oid, typmod): a type's SQL name with its modifier; `???` for an unknown oid. */
export function formatType(state: DatabaseState, oid: number, typmod: number | null): string {
  for (const [elem, arrayOid] of Object.entries(ARRAY_OIDS)) {
    if (arrayOid === oid) {
      const elemOid = TYPE_OIDS[elem];
      if (elemOid !== undefined) return `${formatScalar(state, elemOid, typmod)}[]`;
    }
  }
  return formatScalar(state, oid, typmod);
}
