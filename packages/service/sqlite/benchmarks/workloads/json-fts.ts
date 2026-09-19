import type { BenchSpec } from "../harness/types.ts";
import { fillFts, fillJsonDocs } from "./populate.ts";
import { spec } from "./tiers.ts";

/**
 * JSON / FTS microbenchmarks.
 *
 * Local-first guidance:
 * - Prefer json_extract / ->> / json_set for point access.
 * - Avoid json_each on hot paths (row expansion); normalize or index extracted fields.
 * - FTS MATCH currently filters after a virtual-table scan; fine for small corpora.
 */
export function jsonSpecs(): BenchSpec[] {
  return [
    spec({
      name: "json/extract/500",
      operation: "json_extract",
      datasetSize: 500,
      tiers: ["ci", "default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 8,
      setup: (engine) => {
        fillJsonDocs(engine, 500);
        return engine.prepare("SELECT id, json_extract(data, '$.nested.score') AS score FROM docs WHERE id = ?");
      },
      fn: (_engine, ctx) => {
        (ctx as { get: (id: number) => unknown }).get(250);
      },
    }),
    spec({
      name: "json/arrow/500",
      operation: "json ->>",
      datasetSize: 500,
      tiers: ["default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 8,
      setup: (engine) => {
        fillJsonDocs(engine, 500);
        return engine.prepare("SELECT id, data ->> '$.name' AS name FROM docs WHERE id = ?");
      },
      fn: (_engine, ctx) => {
        (ctx as { get: (id: number) => unknown }).get(250);
      },
    }),
    spec({
      name: "json/set/500",
      operation: "json_set",
      datasetSize: 500,
      tiers: ["default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 8,
      setup: (engine) => {
        fillJsonDocs(engine, 500);
        return engine.prepare("UPDATE docs SET data = json_set(data, '$.nested.score', ?) WHERE id = ?");
      },
      fn: (_engine, ctx) => {
        (ctx as { run: (...a: unknown[]) => unknown }).run(42, 250);
      },
    }),
    spec({
      name: "json/each/200",
      operation: "json_each (row expansion — avoid on hot paths)",
      datasetSize: 200,
      tiers: ["default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 6,
      setup: (engine) => {
        fillJsonDocs(engine, 200);
        return engine.prepare("SELECT d.id, e.value FROM docs d, json_each(d.data, '$.tags') e WHERE d.id = ?");
      },
      fn: (_engine, ctx) => {
        (ctx as { all: (id: number) => unknown }).all(20);
      },
    }),
  ];
}

export function ftsSpecs(): BenchSpec[] {
  return [
    spec({
      name: "fts/match/200",
      operation: "FTS MATCH (scan + filter)",
      datasetSize: 200,
      tiers: ["ci", "default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 8,
      setup: (engine) => {
        fillFts(engine, 200);
        return engine.prepare("SELECT content FROM docs WHERE docs MATCH ? LIMIT 20");
      },
      fn: (_engine, ctx) => {
        (ctx as { all: (q: string) => unknown }).all("alpha");
      },
    }),
    spec({
      name: "fts/match/2000",
      operation: "FTS MATCH (scan + filter)",
      datasetSize: 2000,
      tiers: ["default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 6,
      setup: (engine) => {
        fillFts(engine, 2000);
        return engine.prepare("SELECT content FROM docs WHERE docs MATCH ? LIMIT 20");
      },
      fn: (_engine, ctx) => {
        (ctx as { all: (q: string) => unknown }).all("bravo");
      },
    }),
  ];
}
