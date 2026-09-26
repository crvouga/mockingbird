import { readFileSync } from "node:fs";
import { join } from "node:path";

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

export type DiffClass =
  | { kind: "equal" }
  | { kind: "known-divergence"; id: string }
  | { kind: "failure"; reason: string };

let cached: DivergenceFile | undefined;

export function loadDivergences(root = join(import.meta.dir, "../..")): DivergenceFile {
  if (cached) {
    return cached;
  }
  const path = join(root, "compat/divergences.json");
  cached = JSON.parse(readFileSync(path, "utf8")) as DivergenceFile;
  return cached;
}

export function resetDivergenceCache(): void {
  cached = undefined;
}

export function divergenceById(id: string): DivergenceEntry | undefined {
  return loadDivergences().entries.find((entry) => entry.id === id);
}

export function knownDivergenceIds(): Set<string> {
  return new Set(loadDivergences().entries.map((entry) => entry.id));
}

/**
 * Classify an observed mem≠oracle reason.
 * `allowed` is the set of 𝔇 ids the caller is willing to accept for this site.
 * Anything else is FAILURE — unexplained diffs cannot be green.
 */
export function classifyDiff(reason: string | undefined, allowed: readonly string[] = []): DiffClass {
  if (!reason) return { kind: "equal" };
  for (const id of allowed) {
    if (!divergenceById(id)) continue;
    if (matchesDivergence(id, reason)) return { kind: "known-divergence", id };
  }
  return { kind: "failure", reason };
}

function matchesDivergence(id: string, reason: string): boolean {
  switch (id) {
    case "fts-shadow-counters":
      return /changes mismatch|totalChanges mismatch/.test(reason);
    case "js-api-surface":
      return /column name mismatch/.test(reason);
    case "negzero-canonicalization":
      return /value mismatch/.test(reason);
    default:
      return false;
  }
}
