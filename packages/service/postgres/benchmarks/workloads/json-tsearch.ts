import type { BenchSpec, BenchStatement } from "../harness/types.ts";
import { fillArticles, fillJsonDocs } from "./populate.ts";
import { spec } from "./tiers.ts";

/**
 * JSONB / full-text-search microbenchmarks (Postgres analog of sqlite-mem's
 * json-fts workload): `->` / `->>` / `@>` operators plus tsvector `@@`.
 */
export function jsonSpecs(): BenchSpec[] {
  return [
    spec({
      name: "json/arrow-text/500",
      operation: "jsonb ->> point access",
      datasetSize: 500,
      tiers: ["ci", "default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 8,
      setup: async (engine) => {
        await fillJsonDocs(engine, 500);
        return engine.prepare("SELECT id, data ->> 'name' AS name FROM docs WHERE id = $1");
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).get(250);
      },
    }),
    spec({
      name: "json/arrow-nested/500",
      operation: "jsonb -> then ->> nested access",
      datasetSize: 500,
      tiers: ["ci", "default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 8,
      setup: async (engine) => {
        await fillJsonDocs(engine, 500);
        return engine.prepare("SELECT id, data -> 'nested' ->> 'score' AS score FROM docs WHERE id = $1");
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).get(250);
      },
    }),
    spec({
      name: "json/contains/500",
      operation: "jsonb @> containment scan",
      datasetSize: 500,
      tiers: ["ci", "default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 8,
      setup: async (engine) => {
        await fillJsonDocs(engine, 500);
        return engine.prepare("SELECT COUNT(*) AS c FROM docs WHERE data @> $1::jsonb");
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).get('{"flag": true}');
      },
    }),
    spec({
      name: "json/set/500",
      operation: "jsonb_set",
      datasetSize: 500,
      tiers: ["default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 8,
      setup: async (engine) => {
        await fillJsonDocs(engine, 500);
        return engine.prepare("UPDATE docs SET data = jsonb_set(data, '{nested,score}', $1::jsonb) WHERE id = $2");
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).run("42", 250);
      },
    }),
  ];
}

export function tsearchSpecs(): BenchSpec[] {
  return [
    spec({
      name: "tsearch/match/200",
      operation: "tsvector @@ to_tsquery",
      datasetSize: 200,
      tiers: ["ci", "default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 8,
      setup: async (engine) => {
        await fillArticles(engine, 200);
        return engine.prepare("SELECT id FROM articles WHERE tsv @@ to_tsquery('english', $1) LIMIT 20");
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).all("alpha");
      },
    }),
    spec({
      name: "tsearch/match/2000",
      operation: "tsvector @@ to_tsquery",
      datasetSize: 2000,
      tiers: ["default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 6,
      setup: async (engine) => {
        await fillArticles(engine, 2000);
        return engine.prepare("SELECT id FROM articles WHERE tsv @@ to_tsquery('english', $1) LIMIT 20");
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).all("bravo");
      },
    }),
    spec({
      name: "tsearch/rank/200",
      operation: "ts_rank ordering",
      datasetSize: 200,
      tiers: ["default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 6,
      setup: async (engine) => {
        await fillArticles(engine, 200);
        return engine.prepare(
          "SELECT id, ts_rank(tsv, to_tsquery('english', $1)) AS r FROM articles WHERE tsv @@ to_tsquery('english', $1) ORDER BY r DESC, id LIMIT 10",
        );
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).all("alpha | bravo");
      },
    }),
  ];
}
