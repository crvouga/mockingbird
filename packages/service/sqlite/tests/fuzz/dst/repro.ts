import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fuzzSeed } from "../config.ts";
import { formatReproAdvice, minimizeToSql } from "./minimize.ts";
import type { MixedOp } from "./ops.ts";

const CORPUS_DIR = join(import.meta.dir, "../../corpus/regressions");
const DST_REPRO_DIR = join(import.meta.dir, "../../../tests/dst/repros");

export function corpusPath(slug: string): string {
  const safe = slug.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "repro";
  return join(CORPUS_DIR, `${safe}.sql`);
}

/** Write minimized SQL under tests/corpus/regressions (committed forever). */
export function writeCorpusRepro(slug: string, ops: readonly MixedOp[]): string {
  mkdirSync(CORPUS_DIR, { recursive: true });
  const path = corpusPath(slug);
  writeFileSync(path, minimizeToSql(ops), "utf8");
  return path;
}

/** Write a timestamped shrink artifact under tests/dst/repros (local / CI artifact). */
export function writeDstReproArtifact(ops: readonly MixedOp[], slug?: string): string {
  mkdirSync(DST_REPRO_DIR, { recursive: true });
  const name = slug ?? `mixed-${fuzzSeed()}-${Date.now()}`;
  const path = join(DST_REPRO_DIR, `${name}.sql`);
  writeFileSync(path, formatReproAdvice(ops, fuzzSeed()), "utf8");
  return path;
}
