/** Compare actual source from a Git revision with this checkout. No worktree or branch changes. */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { Database } from "../src/index.ts";

const root = await realpath(join(import.meta.dir, "../../../.."));
const refIndex = process.argv.indexOf("--baseline");
const baseline = refIndex >= 0 ? process.argv[refIndex + 1] : "HEAD";
if (!baseline || baseline.startsWith("-")) throw new Error("Expected --baseline <git revision>");
const directory = await mkdtemp(join(tmpdir(), "mockingbird-storage-benchmark-"));
const changed = new Set([
  "packages/service/core/src/collection.ts",
  "packages/service/sqlite/src/storage/table.ts",
  "packages/service/sqlite/src/executor/dml.ts",
  "packages/service/sqlite/src/indexes/index.ts",
  "packages/service/postgres/src/indexes/index.ts",
]);

async function build(original: boolean): Promise<string> {
  const result = await Bun.build({
    entrypoints: ["storage-benchmark-entry"],
    target: "bun",
    plugins: [
      {
        name: "benchmark-sources",
        setup(builder) {
          builder.onResolve({ filter: /^storage-benchmark-entry$/ }, () => ({ path: "entry", namespace: "benchmark" }));
          builder.onLoad({ filter: /.*/, namespace: "benchmark" }, () => ({
            contents: `export { Database } from ${JSON.stringify(join(root, "packages/service/sqlite/src/index.ts"))};
export { Collection } from ${JSON.stringify(join(root, "packages/service/core/src/collection.ts"))};
export { migrateCore } from ${JSON.stringify(join(root, "packages/sqlite/src/schema.ts"))};
export { IndexStore as SqliteIndex } from ${JSON.stringify(join(root, "packages/service/sqlite/src/indexes/index.ts"))};
export { IndexStore as PostgresIndex } from ${JSON.stringify(join(root, "packages/service/postgres/src/indexes/index.ts"))};`,
            loader: "ts",
          }));
          if (original)
            builder.onLoad({ filter: /\.ts$/ }, async (args) => {
              const path = relative(root, await realpath(args.path));
              if (!changed.has(path)) return undefined;
              const git = Bun.spawnSync(["git", "show", `${baseline}:${path}`], { cwd: root });
              if (git.exitCode !== 0) throw new Error(git.stderr.toString());
              return { contents: git.stdout.toString(), loader: "ts" };
            });
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs);
  const path = join(directory, original ? "baseline.mjs" : "current.mjs");
  const output = result.outputs[0];
  if (!output) throw new Error("Missing benchmark bundle");
  await Bun.write(path, output);
  return path;
}

type Module = {
  Database: typeof Database;
  Collection: typeof import("../../core/src/collection.ts").Collection;
  migrateCore: (db: Database) => void;
  SqliteIndex: typeof import("../src/indexes/index.ts").IndexStore;
  PostgresIndex: typeof import("../../postgres/src/indexes/index.ts").IndexStore;
};

function measure(setup: () => () => void): number {
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const run = setup();
    const start = performance.now();
    run();
    const elapsed = performance.now() - start;
    if (i >= 3) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  return samples[4]!;
}

function run(module: Module): Record<string, number> {
  const results: Record<string, number> = {};
  for (const count of [1000, 10000]) {
    results[`insert-${count}`] = measure(() => {
      const db = new module.Database();
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
      const insert = db.prepare("INSERT INTO t VALUES (?, ?)");
      return () => {
        db.transaction(() => {
          for (let i = 0; i < count; i++) insert.run(i, `row-${i}`);
        });
        if (Number(db.query<{ n: number }>("SELECT COUNT(*) AS n FROM t")[0]?.n) !== count)
          throw new Error("Lost rows");
        db.close();
      };
    });
  }
  results["collection-10000-reads"] = measure(() => {
    const db = new module.Database();
    module.migrateCore(db);
    const collection = new module.Collection<{ name: string }>(db, "benchmark", "records");
    collection.insert("id", { name: "value" });
    return () => {
      for (let i = 0; i < 10000; i++) if (collection.get("id")?.name !== "value") throw new Error("Lost record");
      db.close();
    };
  });
  results["postgres-100-index-forks-10000-keys"] = measure(() => {
    const index = new module.PostgresIndex("benchmark");
    for (let i = 0; i < 10000; i++) index.insert(String(i), i);
    return () => {
      for (let i = 0; i < 100; i++) if (index.clone().size !== 10000) throw new Error("Lost index");
    };
  });
  results["sqlite-100-index-fork-writes-10000-keys"] = measure(() => {
    const index = new module.SqliteIndex("benchmark");
    for (let i = 0; i < 10000; i++) index.insert([i], i);
    index.freeze();
    return () => {
      for (let i = 0; i < 100; i++) {
        const fork = index.clone();
        fork.insert([10001], 10001);
        if (fork.size !== 10001 || index.size !== 10000) throw new Error("Aliased index");
      }
    };
  });
  return results;
}

try {
  const beforePath = await build(true);
  const afterPath = await build(false);
  const beforeModule = (await import(pathToFileURL(beforePath).href)) as Module;
  const afterModule = (await import(pathToFileURL(afterPath).href)) as Module;
  const before = run(beforeModule);
  Bun.gc(true);
  const after = run(afterModule);
  console.log(
    JSON.stringify(
      {
        baseline,
        runtime: Bun.version,
        samples: 9,
        results: Object.keys(before).map((name) => ({
          name,
          baselineMedianMs: before[name],
          currentMedianMs: after[name],
          speedup: before[name]! / after[name]!,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
