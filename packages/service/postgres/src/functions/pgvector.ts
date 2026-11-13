import type { CreateIndexStmt, Expr } from "../ast/nodes.ts";
import { pgError, unsupported } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { extensionMembers } from "../schema/extensions.ts";
import type { DatabaseState, FunctionData, TableData } from "../storage/database-state.ts";
import { castTo } from "../types/cast.ts";
import {
  type Datum,
  datumText,
  type PgArray,
  type TypedValue,
  type TypeId,
  tv,
  typeDisplayName,
  UTC_OUTPUT,
} from "../types/value.ts";
import {
  arrayToVector,
  binaryQuantize,
  checkExpectedDim,
  cosineDistance,
  innerProduct,
  l1Distance,
  l2Distance,
  l2Normalize,
  l2SquaredDistance,
  negativeInnerProduct,
  sphericalDistance,
  subvector,
  VectorAvgState,
  VectorSumState,
  vectorAdd,
  vectorCompare,
  vectorConcat,
  vectorDims,
  vectorMul,
  vectorNorm,
  vectorSub,
  vectorToFloat4Array,
} from "../types/vector.ts";
import type { AggregateAcc } from "./aggregates.ts";

/** Marks the functions `CREATE EXTENSION vector` installs (survives PGMM). */
const PGVECTOR_BODY = "vector";

type Signature = readonly [name: string, args: readonly TypeId[], returns: TypeId];

const VV = ["vector", "vector"] as const;

/**
 * pgvector 0.8.1's functions on `vector` and `bit`, as `pg_proc` lists them. Type I/O,
 * aggregate support and index access method handlers are installed too so the catalog
 * matches, but calling them fails loud (they take internal or cstring arguments).
 */
const SIGNATURES: readonly Signature[] = [
  ["vector_in", ["cstring", "oid", "int4"], "vector"],
  ["vector_out", ["vector"], "cstring"],
  ["vector_typmod_in", ["cstring[]"], "int4"],
  ["vector_recv", ["internal", "oid", "int4"], "vector"],
  ["vector_send", ["vector"], "bytea"],
  ["l2_distance", VV, "float8"],
  ["inner_product", VV, "float8"],
  ["cosine_distance", VV, "float8"],
  ["l1_distance", VV, "float8"],
  ["vector_dims", ["vector"], "int4"],
  ["vector_norm", ["vector"], "float8"],
  ["l2_normalize", ["vector"], "vector"],
  ["binary_quantize", ["vector"], "bit"],
  ["subvector", ["vector", "int4", "int4"], "vector"],
  ["vector_add", VV, "vector"],
  ["vector_sub", VV, "vector"],
  ["vector_mul", VV, "vector"],
  ["vector_concat", VV, "vector"],
  ["vector_lt", VV, "bool"],
  ["vector_le", VV, "bool"],
  ["vector_eq", VV, "bool"],
  ["vector_ne", VV, "bool"],
  ["vector_ge", VV, "bool"],
  ["vector_gt", VV, "bool"],
  ["vector_cmp", VV, "int4"],
  ["vector_l2_squared_distance", VV, "float8"],
  ["vector_negative_inner_product", VV, "float8"],
  ["vector_spherical_distance", VV, "float8"],
  ["vector_accum", ["float8[]", "vector"], "float8[]"],
  ["vector_avg", ["float8[]"], "vector"],
  ["vector_combine", ["float8[]", "float8[]"], "float8[]"],
  ["vector", ["vector", "int4", "bool"], "vector"],
  ["array_to_vector", ["int4[]", "int4", "bool"], "vector"],
  ["array_to_vector", ["float4[]", "int4", "bool"], "vector"],
  ["array_to_vector", ["float8[]", "int4", "bool"], "vector"],
  ["array_to_vector", ["numeric[]", "int4", "bool"], "vector"],
  ["vector_to_float4", ["vector", "int4", "bool"], "float4[]"],
  ["ivfflathandler", ["internal"], "index_am_handler"],
  ["hnswhandler", ["internal"], "index_am_handler"],
  ["ivfflat_bit_support", ["internal"], "internal"],
  ["hnsw_bit_support", ["internal"], "internal"],
  ["hamming_distance", ["bit", "bit"], "float8"],
  ["jaccard_distance", ["bit", "bit"], "float8"],
];

/** The schema `vector` is installed in, or null. */
export function pgvectorSchema(state: DatabaseState): string | null {
  return extensionMembers(state, PGVECTOR_BODY)[0]?.schema ?? null;
}

export function pgvectorInstalled(state: DatabaseState): boolean {
  return pgvectorSchema(state) !== null;
}

export function installPgvector(state: DatabaseState, schemaName: string): void {
  const schema = state.getSchema(schemaName);
  for (const [name, args, returns] of SIGNATURES) {
    const fn: FunctionData = {
      name,
      schema: schema.name,
      argNames: args.map(() => null),
      argTypes: args.slice(),
      argDefaults: args.map(() => null),
      returns,
      returnsSet: false,
      returnsTable: null,
      language: "internal",
      body: null,
      rawBody: PGVECTOR_BODY,
      strict: true,
      volatility: "immutable",
      oid: state.nextOid(),
    };
    schema.functions.set(name, [...(schema.functions.get(name) ?? []), fn]);
  }
}

export function uninstallPgvector(state: DatabaseState): void {
  for (const schema of state.schemas.values()) {
    for (const [name, fns] of [...schema.functions.entries()]) {
      const keep = fns.filter((fn) => fn.language !== "internal" || fn.rawBody !== PGVECTOR_BODY);
      if (keep.length === fns.length) continue;
      if (keep.length === 0) schema.functions.delete(name);
      else schema.functions.set(name, keep);
    }
  }
}

function bits(value: TypedValue): string {
  return datumText(value.t, value.v, UTC_OUTPUT);
}

/** hamming_distance / jaccard_distance over two bit strings of the same length. */
function bitDistance(name: "hamming" | "jaccard", left: TypedValue, right: TypedValue): number {
  const a = bits(left);
  const b = bits(right);
  if (a.length !== b.length) {
    throw pgError("data_exception", `different bit lengths ${a.length} and ${b.length}`, "22000");
  }
  let differ = 0;
  let both = 0;
  let onesA = 0;
  let onesB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] === "1";
    const y = b[i] === "1";
    if (x !== y) differ++;
    if (x && y) both++;
    if (x) onesA++;
    if (y) onesB++;
  }
  if (name === "hamming") return differ;
  if (both === 0) return 1;
  return 1 - both / (onesA + onesB - both);
}

/** A pgvector function call (`LANGUAGE internal`, body `vector`). */
export function evalPgvectorFunction(ctx: EngineCtx, fn: FunctionData, rawArgs: TypedValue[]): TypedValue {
  const ret = fn.returns ?? "vector";
  if (rawArgs.some((arg) => arg.v === null)) return tv(ret, null);
  const args = rawArgs.map((arg, i) => castTo(ctx, arg, fn.argTypes[i] ?? arg.t));
  const v = (i: number): Datum => args[i]!.v;
  const int = (i: number): number => v(i) as number;
  switch (fn.name) {
    case "l2_distance":
      return tv(ret, l2Distance(v(0), v(1)));
    case "inner_product":
      return tv(ret, innerProduct(v(0), v(1)));
    case "cosine_distance":
      return tv(ret, cosineDistance(v(0), v(1)));
    case "l1_distance":
      return tv(ret, l1Distance(v(0), v(1)));
    case "vector_dims":
      return tv(ret, vectorDims(v(0)));
    case "vector_norm":
      return tv(ret, vectorNorm(v(0)));
    case "l2_normalize":
      return tv(ret, l2Normalize(v(0)));
    case "binary_quantize":
      return tv(ret, binaryQuantize(v(0)));
    case "subvector":
      return tv(ret, subvector(v(0), int(1), int(2)));
    case "vector_add":
      return tv(ret, vectorAdd(v(0), v(1)));
    case "vector_sub":
      return tv(ret, vectorSub(v(0), v(1)));
    case "vector_mul":
      return tv(ret, vectorMul(v(0), v(1)));
    case "vector_concat":
      return tv(ret, vectorConcat(v(0), v(1)));
    case "vector_lt":
      return tv(ret, vectorCompare(v(0), v(1)) < 0);
    case "vector_le":
      return tv(ret, vectorCompare(v(0), v(1)) <= 0);
    case "vector_eq":
      return tv(ret, vectorCompare(v(0), v(1)) === 0);
    case "vector_ne":
      return tv(ret, vectorCompare(v(0), v(1)) !== 0);
    case "vector_ge":
      return tv(ret, vectorCompare(v(0), v(1)) >= 0);
    case "vector_gt":
      return tv(ret, vectorCompare(v(0), v(1)) > 0);
    case "vector_cmp":
      return tv(ret, vectorCompare(v(0), v(1)));
    case "vector_l2_squared_distance":
      return tv(ret, l2SquaredDistance(v(0), v(1)));
    case "vector_negative_inner_product":
      return tv(ret, negativeInnerProduct(v(0), v(1)));
    case "vector_spherical_distance":
      return tv(ret, sphericalDistance(v(0), v(1)));
    case "vector": {
      checkExpectedDim(int(1), vectorDims(v(0)));
      return tv(ret, v(0));
    }
    case "array_to_vector":
      return tv(ret, arrayToVector(args[0]!.t, v(0) as PgArray, int(1)));
    case "vector_to_float4":
      return tv(ret, vectorToFloat4Array(v(0)));
    case "hamming_distance":
      return tv(ret, bitDistance("hamming", args[0]!, args[1]!));
    case "jaccard_distance":
      return tv(ret, bitDistance("jaccard", args[0]!, args[1]!));
    default:
      throw unsupported(`pgvector function ${fn.name}`);
  }
}

// --- operators ----------------------------------------------------------------------------

const DISTANCE_OPS: Readonly<Record<string, (a: Datum, b: Datum) => number>> = {
  "<->": l2Distance,
  "<#>": negativeInnerProduct,
  "<=>": cosineDistance,
  "<+>": l1Distance,
};
const ARITHMETIC_OPS: Readonly<Record<string, (a: Datum, b: Datum) => string>> = {
  "+": vectorAdd,
  "-": vectorSub,
  "*": vectorMul,
  "||": vectorConcat,
};
const COMPARISON_OPS: Readonly<Record<string, (c: number) => boolean>> = {
  "=": (c) => c === 0,
  "<>": (c) => c !== 0,
  "<": (c) => c < 0,
  "<=": (c) => c <= 0,
  ">": (c) => c > 0,
  ">=": (c) => c >= 0,
};
/** `bit <~> bit` (Hamming) and `bit <%> bit` (Jaccard). */
const BIT_OPS: Readonly<Record<string, "hamming" | "jaccard">> = { "<~>": "hamming", "<%>": "jaccard" };

function opNotExist(op: string, l: TypeId, r: TypeId): never {
  throw pgError(
    "undefined_function",
    `operator does not exist: ${typeDisplayName(l)} ${op} ${typeDisplayName(r)}`,
    "42883",
  );
}

/**
 * pgvector's operators: null when neither side is a vector (or a bit string for `<~>` / `<%>`),
 * so the built-in operators apply. An unknown literal on one side resolves to vector.
 */
export function evalPgvectorBinary(ctx: EngineCtx, op: string, l: TypedValue, r: TypedValue): TypedValue | null {
  const distance = DISTANCE_OPS[op];
  const bitOp = BIT_OPS[op];
  if (bitOp !== undefined && pgvectorInstalled(ctx.state)) {
    const isBit = (t: TypeId) => t === "bit" || t === "varbit" || t === "unknown";
    if (!isBit(l.t) || !isBit(r.t)) opNotExist(op, l.t, r.t);
    if (l.v === null || r.v === null) return tv("float8", null);
    return tv("float8", bitDistance(bitOp, castTo(ctx, l, "bit"), castTo(ctx, r, "bit")));
  }
  if (l.t !== "vector" && r.t !== "vector") {
    if (distance !== undefined && l.t === "unknown" && r.t === "unknown" && pgvectorInstalled(ctx.state)) {
      throw pgError("ambiguous_function", `operator is not unique: unknown ${op} unknown`, "42725");
    }
    return null;
  }
  const arithmetic = ARITHMETIC_OPS[op];
  const comparison = COMPARISON_OPS[op];
  if (distance === undefined && arithmetic === undefined && comparison === undefined) return null;
  const left = l.t === "unknown" ? castTo(ctx, l, "vector") : l;
  const right = r.t === "unknown" ? castTo(ctx, r, "vector") : r;
  if (left.t !== "vector" || right.t !== "vector") {
    // `vector = real[]` and friends compare as real[] through the implicit cast
    if (comparison !== undefined) return null;
    opNotExist(op, l.t, r.t);
  }
  const resultType = distance ? "float8" : arithmetic ? "vector" : "bool";
  if (left.v === null || right.v === null) return tv(resultType, null);
  if (distance) return tv(resultType, distance(left.v, right.v));
  if (arithmetic) return tv(resultType, arithmetic(left.v, right.v));
  return tv(resultType, comparison!(vectorCompare(left.v, right.v)));
}

// --- aggregates ---------------------------------------------------------------------------

/** avg(vector) / sum(vector). */
export function vectorAggregate(kind: "avg" | "sum"): AggregateAcc {
  const state = kind === "avg" ? new VectorAvgState() : new VectorSumState();
  return {
    step(args: TypedValue[]): void {
      const value = args[0];
      if (value === undefined || value.v === null) return;
      state.step(value.v);
    },
    result(): TypedValue {
      return tv("vector", state.result());
    },
  };
}

// --- indexes ------------------------------------------------------------------------------

/** pgvector's index access methods and the `pg_am` oids they get here (PostgreSQL assigns them at install). */
export const PGVECTOR_ACCESS_METHODS: ReadonlyMap<string, number> = new Map([
  ["ivfflat", 13610],
  ["hnsw", 13611],
]);

/** The operator classes each method has for `vector`; the first ivfflat one is its default. */
const OPCLASSES: Readonly<Record<string, readonly string[]>> = {
  ivfflat: ["vector_l2_ops", "vector_ip_ops", "vector_cosine_ops"],
  hnsw: ["vector_l2_ops", "vector_ip_ops", "vector_cosine_ops", "vector_l1_ops"],
};

/** The opclass PostgreSQL picks (and does not print) for a vector key, or null when it has none. */
export function pgvectorDefaultOpclass(method: string): string | null {
  if (method === "btree") return "vector_ops";
  if (method === "ivfflat") return "vector_l2_ops";
  return null;
}

/** Every operator class pgvector adds (for DROP EXTENSION dependency tracking). */
export const PGVECTOR_OPCLASSES: readonly string[] = ["vector_ops", ...OPCLASSES.hnsw!];

/** HNSW_MAX_DIM / IVFFLAT_MAX_DIM for vector keys. */
const MAX_INDEX_DIMS = 2000;

const OPTION_BOUNDS: Readonly<Record<string, Readonly<Record<string, readonly [number, number, number]>>>> = {
  ivfflat: { lists: [1, 32768, 100] },
  hnsw: { m: [2, 100, 16], ef_construction: [4, 1000, 64] },
};

/**
 * CREATE INDEX ... USING hnsw | ivfflat: accepted (as an exact, non-approximate index) for one
 * vector key with a vector operator class and in-range options, while pgvector is installed.
 */
export function assertPgvectorIndex(
  state: DatabaseState,
  table: TableData,
  stmt: CreateIndexStmt,
  expressionType: (expr: Expr) => TypeId,
): void {
  const method = stmt.using ?? "btree";
  const opclasses = OPCLASSES[method];
  if (opclasses === undefined || !pgvectorInstalled(state)) return;
  if (stmt.columns.length > 1) {
    throw pgError("feature_not_supported", `access method "${method}" does not support multicolumn indexes`, "0A000");
  }
  if (stmt.include.length > 0) {
    throw pgError("feature_not_supported", `access method "${method}" does not support included columns`, "0A000");
  }
  const col = stmt.columns[0]!;
  const typeId =
    col.expr.type === "colref" && col.expr.parts.length === 1
      ? table.columns[table.columnIndex(col.expr.parts[0]!)]!.type.id
      : expressionType(col.expr);
  const opclass = col.opclass?.[col.opclass.length - 1] ?? null;
  if (opclass === null) {
    if (typeId !== "vector" || pgvectorDefaultOpclass(method) === null) {
      throw pgError(
        "undefined_object",
        `data type ${typeDisplayName(typeId)} has no default operator class for access method "${method}"`,
        "42704",
      );
    }
  } else {
    if (!opclasses.includes(opclass)) {
      throw pgError(
        "undefined_object",
        `operator class "${col.opclass!.join(".")}" does not exist for access method "${method}"`,
        "42704",
      );
    }
    if (typeId !== "vector") {
      throw pgError(
        "datatype_mismatch",
        `operator class "${opclass}" does not accept data type ${typeDisplayName(typeId)}`,
        "42804",
      );
    }
  }
  // the index needs the key's dimensions: a vector(n) column or an expression cast to vector(n)
  const dims =
    col.expr.type === "colref" && col.expr.parts.length === 1
      ? table.columns[table.columnIndex(col.expr.parts[0]!)]!.type.mod?.a
      : col.expr.type === "cast"
        ? col.expr.target.mods[0]
        : undefined;
  if (dims === undefined) throw pgError("invalid_parameter_value", "column does not have dimensions", "22023");
  if (dims > MAX_INDEX_DIMS) {
    throw pgError(
      "program_limit_exceeded",
      `column cannot have more than ${MAX_INDEX_DIMS} dimensions for ${method} index`,
      "54000",
    );
  }
  const bounds = OPTION_BOUNDS[method]!;
  const values: Record<string, number> = {};
  for (const option of stmt.options ?? []) {
    const range = bounds[option.name];
    if (range === undefined)
      throw pgError("invalid_parameter_value", `unrecognized parameter "${option.name}"`, "22023");
    const value = Number(option.value);
    if (!Number.isInteger(value)) {
      throw pgError(
        "invalid_parameter_value",
        `invalid value for integer option "${option.name}": ${option.value}`,
        "22023",
      );
    }
    if (value < range[0] || value > range[1]) {
      throw pgError(
        "invalid_parameter_value",
        `value ${option.value} out of bounds for option "${option.name}"`,
        "22023",
      );
    }
    values[option.name] = value;
  }
  if (method === "hnsw") {
    const m = values.m ?? bounds.m![2];
    const ef = values.ef_construction ?? bounds.ef_construction![2];
    if (ef < 2 * m) {
      throw pgError("invalid_parameter_value", "ef_construction must be greater than or equal to 2 * m", "22023");
    }
  }
}
