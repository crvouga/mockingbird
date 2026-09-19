import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ErrorCategory } from "./types.ts";

/**
 * Map a five-character SQLSTATE to a coarse category. Shared by both adapters
 * so classification can never diverge between backends.
 */
export function categoryFromSqlstate(code: string | undefined): ErrorCategory {
  if (code?.length !== 5) return "other";
  switch (code) {
    case "42601":
    case "42P02":
      return "syntax";
    case "42P01":
      return "undefined_table";
    case "42703":
      return "undefined_column";
    case "42883":
      return "undefined_function";
    case "42704":
    case "3F000":
      return "undefined_object";
    case "42710":
    case "42P07":
    case "42701":
    case "42P06":
    case "42723":
    case "42P05":
      return "duplicate_object";
    case "23505":
      return "constraint_unique";
    case "23502":
      return "constraint_notnull";
    case "23514":
      return "constraint_check";
    case "23503":
      return "constraint_foreign";
    case "22012":
      return "division_by_zero";
    case "22P02":
      return "invalid_text_representation";
    case "22003":
      return "numeric_out_of_range";
    case "42804":
    case "42846":
    case "42809":
      return "datatype_mismatch";
    case "22023":
      return "invalid_parameter";
    case "42803":
      return "grouping";
    case "42P20":
      return "windowing";
    case "42702":
    case "42725":
      return "ambiguous";
    case "0A000":
      return "unsupported";
    case "21000":
      return "cardinality";
    case "XX000":
    case "XX001":
      return "misuse";
    default:
      break;
  }
  const cls = code.slice(0, 2);
  switch (cls) {
    case "22":
      return "data_exception";
    case "23":
      return "constraint";
    case "25":
    case "2D":
    case "3B":
    case "40":
      return "transaction";
    case "26":
    case "34":
      return "misuse";
    case "42":
      return "syntax";
    default:
      return "other";
  }
}

export interface DivergenceEntry {
  id: string;
  scope: string;
  predicate: string;
  specifiedBehavior: string;
  pinnedBy: string[];
}

export interface DivergenceFile {
  version: number;
  entries: DivergenceEntry[];
}

let cachedDivergences: DivergenceFile | undefined;

export function loadDivergences(root = join(import.meta.dir, "../..")): DivergenceFile {
  if (cachedDivergences) return cachedDivergences;
  cachedDivergences = JSON.parse(readFileSync(join(root, "compat/divergences.json"), "utf8")) as DivergenceFile;
  return cachedDivergences;
}

export function divergenceById(id: string): DivergenceEntry | undefined {
  return loadDivergences().entries.find((entry) => entry.id === id);
}

export function knownDivergenceIds(): Set<string> {
  return new Set(loadDivergences().entries.map((entry) => entry.id));
}
