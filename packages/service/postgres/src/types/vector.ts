import { pgError } from "../errors/error.ts";
import { type Numeric, numericToNumber } from "./numeric.ts";
import { arrayElemType, type Datum, float4Text, isArrayType, makeArray, type PgArray, type TypeId } from "./value.ts";

/**
 * pgvector's `vector` type (extension `vector` 0.8.1). A datum is the canonical text
 * `vector_out` prints (`[1,2.5,-0]`): every element is a float4 and prints in its
 * shortest round-trip form, so equal vectors have equal text, the value round-trips
 * through PGMM snapshots unchanged, and text output is the identity. Arithmetic works
 * on the float4 elements (`vectorValues`), accumulating the way pgvector's C code does.
 */
export const VECTOR_TYPE: TypeId = "vector";
export const VECTOR_MAX_DIM = 16000;

// --- text I/O ---------------------------------------------------------------------------

/** strtof's grammar: decimal or hexadecimal float, inf/infinity, nan (case-insensitive). */
const FLOAT_TOKEN =
  /^[+-]?(?:0[xX](?:[0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?|nan)/i;

function isVectorSpace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f";
}

function syntaxError(text: string): never {
  throw pgError("invalid_text_representation", `invalid input syntax for type vector: "${text}"`, "22P02");
}

function hexFloat(token: string): number {
  const m = /^([+-]?)0[xX]([0-9a-fA-F]*)\.?([0-9a-fA-F]*)(?:[pP]([+-]?\d+))?$/.exec(token)!;
  const digits = `${m[2]}${m[3]}`;
  let mantissa = 0;
  for (const d of digits) mantissa = mantissa * 16 + Number.parseInt(d, 16);
  const exponent = Number(m[4] ?? 0) - 4 * m[3]!.length;
  const value = mantissa * 2 ** exponent;
  return m[1] === "-" ? -value : value;
}

/** One element as strtof reads it, rounded to float4. */
function tokenValue(token: string): number {
  const lower = token.toLowerCase().replace(/^[+-]/, "");
  const negative = token.startsWith("-");
  if (lower === "nan") return Number.NaN;
  if (lower === "inf" || lower === "infinity") return negative ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  const value = Math.fround(lower.startsWith("0x") ? hexFloat(token) : Number(token));
  if (!Number.isFinite(value)) {
    throw pgError("numeric_value_out_of_range", `"${token}" is out of range for type vector`, "22003");
  }
  return value;
}

/** CheckElement: no NaN and no infinity in a vector. */
function checkElement(value: number): void {
  if (Number.isNaN(value)) throw pgError("data_exception", "NaN not allowed in vector", "22000");
  if (!Number.isFinite(value)) throw pgError("data_exception", "infinite value not allowed in vector", "22000");
}

/** CheckDim: between 1 and 16000 dimensions. */
export function checkVectorDim(dim: number): void {
  if (dim < 1) throw pgError("data_exception", "vector must have at least 1 dimension", "22000");
  if (dim > VECTOR_MAX_DIM) {
    throw pgError("data_exception", `vector cannot have more than ${VECTOR_MAX_DIM} dimensions`, "22000");
  }
}

/** CheckExpectedDim: a `vector(n)` typmod against the actual dimension count. */
export function checkExpectedDim(typmod: number | undefined, dim: number): void {
  if (typmod !== undefined && typmod !== -1 && typmod !== dim) {
    throw pgError("data_exception", `expected ${typmod} dimensions, not ${dim}`, "22000");
  }
}

/** vector_typmod_in: `vector(n)` takes one modifier between 1 and 16000. */
export function vectorTypmodIn(mods: readonly number[]): void {
  if (mods.length === 0) return;
  if (mods.length !== 1) throw pgError("invalid_parameter_value", "invalid type modifier", "22023");
  const dim = mods[0]!;
  if (dim < 1) throw pgError("invalid_parameter_value", "dimensions for type vector must be at least 1", "22023");
  if (dim > VECTOR_MAX_DIM) {
    throw pgError("invalid_parameter_value", `dimensions for type vector cannot exceed ${VECTOR_MAX_DIM}`, "22023");
  }
}

/** vector_in: `[x, y, ...]` with optional whitespace around every token. */
export function parseVectorText(text: string): string {
  const values: number[] = [];
  let pos = 0;
  const skip = () => {
    while (isVectorSpace(text[pos])) pos++;
  };
  skip();
  if (text[pos] !== "[") syntaxError(text);
  pos++;
  skip();
  if (text[pos] === "]") throw pgError("data_exception", "vector must have at least 1 dimension", "22000");
  for (;;) {
    if (values.length === VECTOR_MAX_DIM) {
      throw pgError("program_limit_exceeded", `vector cannot have more than ${VECTOR_MAX_DIM} dimensions`, "54000");
    }
    skip();
    const match = FLOAT_TOKEN.exec(text.slice(pos));
    if (!match) syntaxError(text);
    const value = tokenValue(match[0]);
    checkElement(value);
    values.push(value);
    pos += match[0].length;
    skip();
    if (text[pos] === ",") pos++;
    else if (text[pos] === "]") {
      pos++;
      break;
    } else syntaxError(text);
  }
  skip();
  if (pos !== text.length) syntaxError(text);
  return formatVector(values);
}

/** vector_out: `[` elements in float4 shortest form `]`. */
export function formatVector(values: ArrayLike<number>): string {
  const parts: string[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) parts[i] = float4Text(values[i]!);
  return `[${parts.join(",")}]`;
}

const PARSED = new Map<string, Float32Array>();
const PARSED_LIMIT = 4096;

/** The float4 elements of a vector datum (memoized: a KNN scan reads the same query vector per row). */
export function vectorValues(datum: Datum): Float32Array {
  const text = datum as string;
  const cached = PARSED.get(text);
  if (cached) return cached;
  const inner = text.slice(1, -1);
  const values = Float32Array.from(inner.split(","), Number);
  if (PARSED.size >= PARSED_LIMIT) PARSED.clear();
  PARSED.set(text, values);
  return values;
}

export function vectorDims(datum: Datum): number {
  return vectorValues(datum).length;
}

// --- casts --------------------------------------------------------------------------------

const ARRAY_SOURCES = new Set<TypeId>(["int4[]", "float4[]", "float8[]", "numeric[]"]);

/** `int[]`, `real[]`, `double precision[]` and `numeric[]` cast to vector by assignment. */
export function isVectorArraySource(t: TypeId): boolean {
  return ARRAY_SOURCES.has(t);
}

/** array_to_vector: a 1-D array without NULLs, each element rounded to float4. */
export function arrayToVector(from: TypeId, array: PgArray, typmod: number | undefined): string {
  if (array.dims.length > 1) throw pgError("data_exception", "array must be 1-D", "22000");
  if (array.items.some((item) => item === null)) {
    throw pgError("null_value_not_allowed", "array must not contain nulls", "22004");
  }
  checkVectorDim(array.items.length);
  checkExpectedDim(typmod, array.items.length);
  const elem = arrayElemType(from);
  const values = array.items.map((item) => {
    if (elem === "numeric") {
      const n = Math.fround(numericToNumber(item as Numeric));
      if (!Number.isFinite(n) && Number.isFinite(numericToNumber(item as Numeric))) {
        throw pgError("numeric_value_out_of_range", "value out of range: overflow", "22003");
      }
      return n;
    }
    return Math.fround(item as number);
  });
  for (const value of values) checkElement(value);
  return formatVector(values);
}

/** vector_to_float4: the elements as `real[]`. */
export function vectorToFloat4Array(datum: Datum): PgArray {
  return makeArray("float4", Array.from(vectorValues(datum)));
}

/** Casts into and out of `vector` besides text I/O; undefined when the pair is not one. */
export function vectorCast(from: TypeId, target: TypeId, v: Datum, typmod: number | undefined): Datum | undefined {
  if (target === VECTOR_TYPE && isArrayType(from) && isVectorArraySource(from)) {
    return arrayToVector(from, v as PgArray, typmod);
  }
  if (from === VECTOR_TYPE && target === "float4[]") return vectorToFloat4Array(v);
  return undefined;
}

// --- comparison ---------------------------------------------------------------------------

/** vector_cmp: element-wise over the shorter vector, then the shorter vector first. */
export function vectorCompare(a: Datum, b: Datum): number {
  const x = vectorValues(a);
  const y = vectorValues(b);
  const dim = Math.min(x.length, y.length);
  for (let i = 0; i < dim; i++) {
    if (x[i]! < y[i]!) return -1;
    if (x[i]! > y[i]!) return 1;
  }
  return x.length < y.length ? -1 : x.length > y.length ? 1 : 0;
}

/** A grouping key equal exactly when vector_cmp says equal (`-0` and `0` are the same). */
export function vectorKey(a: Datum): string {
  return (a as string).replace(/(?<=[[,])-0(?=[\],])/g, "0");
}

// --- arithmetic ---------------------------------------------------------------------------

function checkDims(x: Float32Array, y: Float32Array): void {
  if (x.length !== y.length) {
    throw pgError("data_exception", `different vector dimensions ${x.length} and ${y.length}`, "22000");
  }
}

function overflow(): never {
  throw pgError("numeric_value_out_of_range", "value out of range: overflow", "22003");
}

function underflow(): never {
  throw pgError("numeric_value_out_of_range", "value out of range: underflow", "22003");
}

/** `float` accumulation of a per-element term, rounding after every step like C's float arithmetic. */
function floatSum(dim: number, term: (i: number) => number): number {
  let sum = 0;
  for (let i = 0; i < dim; i++) sum = Math.fround(sum + term(i));
  return sum;
}

export function l2SquaredDistance(a: Datum, b: Datum): number {
  const x = vectorValues(a);
  const y = vectorValues(b);
  checkDims(x, y);
  return floatSum(x.length, (i) => {
    const diff = Math.fround(x[i]! - y[i]!);
    return Math.fround(diff * diff);
  });
}

export function l2Distance(a: Datum, b: Datum): number {
  return Math.sqrt(l2SquaredDistance(a, b));
}

export function innerProduct(a: Datum, b: Datum): number {
  const x = vectorValues(a);
  const y = vectorValues(b);
  checkDims(x, y);
  return floatSum(x.length, (i) => Math.fround(x[i]! * y[i]!));
}

export function negativeInnerProduct(a: Datum, b: Datum): number {
  return -innerProduct(a, b);
}

export function cosineDistance(a: Datum, b: Datum): number {
  const x = vectorValues(a);
  const y = vectorValues(b);
  checkDims(x, y);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < x.length; i++) {
    dot = Math.fround(dot + Math.fround(x[i]! * y[i]!));
    normA = Math.fround(normA + Math.fround(x[i]! * x[i]!));
    normB = Math.fround(normB + Math.fround(y[i]! * y[i]!));
  }
  // sqrt(a * b) over sqrt(a) * sqrt(b), in double, clamped to [-1, 1]; 0/0 stays NaN
  let similarity = dot / Math.sqrt(normA * normB);
  if (similarity > 1) similarity = 1;
  else if (similarity < -1) similarity = -1;
  return 1 - similarity;
}

export function sphericalDistance(a: Datum, b: Datum): number {
  let dot = innerProduct(a, b);
  if (dot > 1) dot = 1;
  else if (dot < -1) dot = -1;
  return Math.acos(dot) / Math.PI;
}

export function l1Distance(a: Datum, b: Datum): number {
  const x = vectorValues(a);
  const y = vectorValues(b);
  checkDims(x, y);
  return floatSum(x.length, (i) => Math.abs(Math.fround(x[i]! - y[i]!)));
}

/** vector_norm: accumulated in double. */
export function vectorNorm(a: Datum): number {
  const x = vectorValues(a);
  let norm = 0;
  for (let i = 0; i < x.length; i++) norm += x[i]! * x[i]!;
  return Math.sqrt(norm);
}

/** l2_normalize: a zero vector stays zero; an element that overflows float4 is an error. */
export function l2Normalize(a: Datum): string {
  const x = vectorValues(a);
  const norm = vectorNorm(a);
  if (!(norm > 0)) return formatVector(x);
  const out = Array.from(x, (value) => Math.fround(value / norm));
  if (out.some((value) => !Number.isFinite(value))) overflow();
  return formatVector(out);
}

/** binary_quantize: one bit per element, set when the element is positive. */
export function binaryQuantize(a: Datum): string {
  return Array.from(vectorValues(a), (value) => (value > 0 ? "1" : "0")).join("");
}

/** subvector(v, start, count): 1-based like substring; an empty result is an error. */
export function subvector(a: Datum, start: number, count: number): string {
  const x = vectorValues(a);
  const end = count > 2147483647 - start ? x.length + 1 : start + count;
  let from = start;
  if (from < 1) from = 1;
  else if (from > x.length) throw pgError("data_exception", "vector must have at least 1 dimension", "22000");
  const to = end > x.length ? x.length + 1 : end;
  const dim = to - from;
  checkVectorDim(dim);
  return formatVector(x.subarray(from - 1, to - 1));
}

function elementwise(a: Datum, b: Datum, op: (x: number, y: number) => number, mul: boolean): string {
  const x = vectorValues(a);
  const y = vectorValues(b);
  checkDims(x, y);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = op(x[i]!, y[i]!);
  for (let i = 0; i < out.length; i++) {
    if (!Number.isFinite(out[i]!)) overflow();
    if (mul && out[i] === 0 && !(x[i] === 0 || y[i] === 0)) underflow();
  }
  return formatVector(out);
}

export function vectorAdd(a: Datum, b: Datum): string {
  return elementwise(a, b, (x, y) => x + y, false);
}

export function vectorSub(a: Datum, b: Datum): string {
  return elementwise(a, b, (x, y) => x - y, false);
}

export function vectorMul(a: Datum, b: Datum): string {
  return elementwise(a, b, (x, y) => x * y, true);
}

export function vectorConcat(a: Datum, b: Datum): string {
  const x = vectorValues(a);
  const y = vectorValues(b);
  checkVectorDim(x.length + y.length);
  return `${(a as string).slice(0, -1)},${(b as string).slice(1)}`;
}

// --- aggregates ---------------------------------------------------------------------------

/** avg(vector): vector_accum sums in double; vector_avg divides and rounds to float4. */
export class VectorAvgState {
  private n = 0;
  private sums: Float64Array | null = null;

  step(datum: Datum): void {
    const x = vectorValues(datum);
    if (this.sums === null) this.sums = new Float64Array(x.length);
    else checkExpectedDim(this.sums.length, x.length);
    this.n++;
    for (let i = 0; i < x.length; i++) {
      const v = this.sums[i]! + x[i]!;
      if (!Number.isFinite(v)) overflow();
      this.sums[i] = v;
    }
  }

  result(): string | null {
    if (this.sums === null || this.n === 0) return null;
    checkVectorDim(this.sums.length);
    const out = Array.from(this.sums, (sum) => Math.fround(sum / this.n));
    for (const value of out) checkElement(value);
    return formatVector(out);
  }
}

/** sum(vector): vector_add as the transition function. */
export class VectorSumState {
  private sum: string | null = null;

  step(datum: Datum): void {
    this.sum = this.sum === null ? (datum as string) : vectorAdd(this.sum, datum);
  }

  result(): string | null {
    return this.sum;
  }
}
