/** Boundary-value corpus V for generated matrices (Phase 1 subset: one representative per class plus edges). */

export type ValueClass = "null" | "integer" | "real" | "text_numeric" | "text_non" | "blob";

export interface MatrixValue {
  class: ValueClass;
  sql: string;
  label: string;
}

export const CLASS_REPS: MatrixValue[] = [
  { class: "null", sql: "NULL", label: "null" },
  { class: "integer", sql: "1", label: "int" },
  { class: "real", sql: "1.5", label: "real" },
  { class: "text_numeric", sql: "'12'", label: "text-num" },
  { class: "text_non", sql: "'a'", label: "text-non" },
  { class: "blob", sql: "X'00'", label: "blob" },
];

export const INTEGER_EDGES = ["0", "1", "-1", "127", "128", "2147483647", "2147483648"];
export const REAL_EDGES = ["0.0", "0.5", "-0.5", "1.0", "1e-10", "1e10"];
export const TEXT_NUMERIC = ["'0'", "'1'", "'-1'", "' 12'", "'12 '", "'1.5'", "'1e3'", "'+5'", "''"];
export const CAST_TARGETS = ["INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC"];

export const BINARY_OPS = [
  "+",
  "-",
  "*",
  "/",
  "%",
  "||",
  "=",
  "==",
  "!=",
  "<>",
  "<",
  "<=",
  ">",
  ">=",
  "IS",
  "IS NOT",
  "AND",
  "OR",
  "&",
  "|",
  "<<",
  ">>",
  "LIKE",
  "GLOB",
] as const;

export const AFFINITY_COLUMNS: Array<{ name: string; decl: string }> = [
  { name: "i", decl: "INTEGER" },
  { name: "t", decl: "TEXT" },
  { name: "r", decl: "REAL" },
  { name: "n", decl: "NUMERIC" },
  { name: "b", decl: "BLOB" },
  { name: "x", decl: "" },
];
