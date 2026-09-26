/** Boundary-value corpus for generated operator/cast matrices (one representative per type class plus edges). */

export type ValueClass =
  | "null"
  | "int"
  | "bigint"
  | "numeric"
  | "float"
  | "text_numeric"
  | "text_non"
  | "bool"
  | "bytea";

export interface MatrixValue {
  class: ValueClass;
  sql: string;
  label: string;
}

export const CLASS_REPS: MatrixValue[] = [
  { class: "null", sql: "NULL", label: "null" },
  { class: "int", sql: "1", label: "int" },
  { class: "bigint", sql: "2147483648", label: "bigint" },
  { class: "numeric", sql: "1.5", label: "numeric" },
  { class: "float", sql: "1.5::float8", label: "float8" },
  { class: "text_numeric", sql: "'12'", label: "text-num" },
  { class: "text_non", sql: "'a'", label: "text-non" },
  { class: "bool", sql: "true", label: "bool" },
  { class: "bytea", sql: "'\\x00'::bytea", label: "bytea" },
];

export const INTEGER_EDGES = ["0", "1", "-1", "32767", "32768", "2147483647", "2147483648", "9223372036854775807"];

export const NUMERIC_EDGES = ["0.0", "0.5", "-0.5", "1.0", "0.000001", "99999999999999999999.5"];

export const FLOAT_EDGES = ["0.0::float8", "'-0'::float8", "1e-10::float8", "1e10::float8", "2.5::float8"];

export const TEXT_EDGES = ["'0'", "'1'", "'-1'", "' 12'", "'12 '", "'1.5'", "'1e3'", "'+5'", "''", "'abc'"];

export const CAST_TARGETS = [
  "int2",
  "int4",
  "int8",
  "float4",
  "float8",
  "numeric",
  "text",
  "varchar(3)",
  "bool",
  "bytea",
  "jsonb",
  "date",
  "interval",
];

export const BINARY_OPS = [
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "||",
  "=",
  "<>",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "AND",
  "OR",
  "IS DISTINCT FROM",
  "IS NOT DISTINCT FROM",
  "LIKE",
] as const;
