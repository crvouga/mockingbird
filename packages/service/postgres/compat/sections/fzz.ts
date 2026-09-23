import { type CatalogSection, type ScenarioRow, section } from "../scenario-types.ts";

const F = "fuzz" as const;
const P = "property" as const;

const rows: ScenarioRow[] = [
  ["diff-01", "grammar-based differential fuzz", F, undefined, ["tests/fuzz/differential.test.ts"]],
  ["expr-01", "expression/predicate fuzz", F, undefined, ["tests/fuzz/expressions.test.ts"]],
  ["bind-01", "bind-vs-literal and cast fuzz", F, undefined, ["tests/fuzz/typing-binds.test.ts"]],
  ["like-01", "LIKE/ILIKE and string-function fuzz", F, undefined, ["tests/fuzz/strings-like.test.ts"]],
  ["date-01", "datetime arithmetic fuzz", F, undefined, ["tests/fuzz/datetime.test.ts"]],
  ["jsn-01", "jsonb and array operator fuzz", F, undefined, ["tests/fuzz/json-arrays.test.ts"]],
  ["dml-01", "DML sequence fuzz with state compare", F, undefined, ["tests/fuzz/dml.test.ts"]],
  ["up-01", "ON CONFLICT upsert fuzz", F, undefined, ["tests/fuzz/upsert.test.ts"]],
  ["con-01", "constraint violation outcome fuzz", F, undefined, ["tests/fuzz/constraints.test.ts"]],
  ["fk-01", "FK action fuzz (CASCADE/SET NULL/NO ACTION)", F, undefined, ["tests/fuzz/foreign-keys.test.ts"]],
  ["join-01", "join-type and predicate fuzz", F, undefined, ["tests/fuzz/joins.test.ts"]],
  ["agg-01", "GROUP BY/HAVING/FILTER aggregate fuzz", F, undefined, ["tests/fuzz/aggregates.test.ts"]],
  ["sub-01", "subquery and IN-with-NULL fuzz", F, undefined, ["tests/fuzz/subqueries.test.ts"]],
  ["win-01", "window frame fuzz", F, undefined, ["tests/fuzz/windows.test.ts"]],
  ["cte-01", "CTE chain and recursion fuzz", F, undefined, ["tests/fuzz/cte.test.ts"]],
  ["txn-01", "transaction/savepoint sequence fuzz", F, undefined, ["tests/fuzz/transactions.test.ts"]],
  ["seq-01", "sequence and serial counter fuzz", F, undefined, ["tests/fuzz/sequences-counters.test.ts"]],
  ["tlp-01", "ternary logic partitioning metamorphic", F, undefined, ["tests/fuzz/metamorphic/tlp.test.ts"]],
  ["norec-01", "NoREC metamorphic rewrite", F, undefined, ["tests/fuzz/metamorphic/norec.test.ts"]],
  ["comb-01", "feature combination fuzz", F, undefined, ["tests/fuzz/combinations.test.ts"]],
  ["dst-01", "stateful DST dump-after-each engine", F, undefined, ["tests/fuzz/stateful.test.ts"]],
  ["mix-01", "mixed DDL/DML stateful simulation", F, undefined, ["tests/fuzz/mixed-stateful.test.ts"]],
  ["snap-01", "snapshot restore probe fuzz", F, undefined, ["tests/fuzz/snapshot.test.ts"]],
  ["snap-02", "snapshot object round-trip contracts", F, undefined, ["tests/contract/snapshots/objects.test.ts"]],
  ["snap-03", "extended logical dump (views/matviews/sequences)", F, undefined, ["tests/harness/state-dump.ts"]],
  ["robust-01", "PostgresError-only / snapshot bit-flip robustness", F, undefined, ["tests/fuzz/robustness.test.ts"]],
  ["corpus-01", "corpus regression replay", F, undefined, ["tests/fuzz/corpus.test.ts"]],
  ["num-01", "numeric arithmetic differential fuzz", F, undefined, ["tests/fuzz/numeric.test.ts"]],
  ["cpy-01", "COPY FROM STDIN differential fuzz", F, undefined, ["tests/fuzz/copy.test.ts"]],
  ["seed-01", "default seed 0x5a17e0e1", P, undefined, ["tests/fuzz/config.ts"]],
  ["replay-01", "POSTGRES_MEM_FUZZ_SEED / PATH replay", P, undefined, ["tests/fuzz/config.ts"]],
  ["min-01", "DST minimizer and repro script", P, undefined, ["tests/fuzz/dst/minimize.ts"]],
];

export const FZZ_SECTION: CatalogSection = section("FZZ", "Differential fuzz & property harness", true, rows);
