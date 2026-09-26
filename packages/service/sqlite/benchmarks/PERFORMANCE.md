# SQLite-mem Performance Overhaul

## Environment

- Historical mobile proxy numbers (below): Chromium + `Moto G4` + **4× CPU throttle** (recorded before browser harness removal)
- CPU: host Darwin arm64 for local Bun benches; CI gate uses linux `ci-baseline.json`
- Memory: Bun `process.memoryUsage()`
- Runtime: Bun 1.3.14 (benchmarks + `bun:sqlite` 3.51.0 oracle); shipped artifact is a browser ESM bundle (no WASM)

Commands:

```bash
bun run benchmark
bun run benchmark:bun
bun run benchmark:ci
```

## Baseline

Unoptimized engine (full table scan for every `WHERE`, `IndexStore` uniqueness-only, snapshot `number[]` writer, `restore()` cloned twice). CI-tier, Bun, sqlite-mem:

| Benchmark | p50 | p95 | ops/sec |
| --- | --- | --- | --- |
| PK lookup / 1000 rows (20 lookups) | 11.3 ms | 12.0 ms | 1,763 |
| Unique email index lookup / 1000 | 11.8 ms | 12.7 ms | 1,684 |
| Prepared 1000 PK executes | 578 ms | 793 ms | 1,619 |
| App queries / 200 users | 96 ms | 101 ms | 10 |
| Join small⋈large / 1000 | 10.2 ms | 10.4 ms | 98 |
| CRUD loop ×50 | 18.9 ms | 19.3 ms | 2,652 |
| Snapshot export ~1 MB | 26.1 ms | 29.2 ms | 37 |
| Snapshot hydrate ~1 MB | 1.60 ms | 2.15 ms | 571 |
| 1000 inserts in a transaction | 324 ms | 513 ms | 3,084 |

Same CI suite vs `bun:sqlite` (timing only): PK lookups ~1.86M/sec, prepared executes ~2.1M/sec, 1 MB serialize ~0.28 ms. sqlite-mem was **~100–1000×** slower on point lookups.

Mobile (Moto G4, 4× throttle) baseline:

| Benchmark | p95 |
| --- | --- |
| Prepared 1000 PK executes | 1578 ms |
| App queries / 200 users | 356 ms |
| PK lookup / 1000 rows | 34 ms |
| Snapshot export 1 MB | 100 ms |
| Snapshot hydrate 1 MB | 7.4 ms |

**Bundle (pre-opt):** 383 KB uncompressed / 76 KB gzip / 63 KB brotli.

### Top bottlenecks (from architecture + baseline)

1. **SELECT never used indexes or INTEGER PRIMARY KEY maps** — every `WHERE id = ?` scanned and sorted the table (~30–40%+ of interactive CPU; 1000× vs SQLite on point lookups)
2. **Nested-loop joins** fully materialized both sides even with a unique index on the probe key
3. **`Table.scan()` copied + sorted on every scan**
4. **Snapshot `Writer` built a `number[]` of every byte** (~8× peak vs payload) then `Uint8Array.from`
5. **`restore()` decoded then `replaceWith()` cloned the entire state again**
6. **GROUP BY / DISTINCT used `findIndex` (quadratic)**
7. **Prepared statements re-tokenized SQL to bind named parameters on every execute**
8. **Uncorrelated `col = (SELECT …)` re-evaluated the subquery per scanned row**

## Optimizations

| Optimization | Before (Bun p95) | After (Bun p95) | Improvement | Memory |
| --- | --- | --- | --- | --- |
| PK / unique index point lookup | 12.0 ms / 12.7 ms | 0.058 ms / 0.097 ms | ~200× / ~130× | fewer scan allocations |
| Prepared 1000 PK executes | 793 ms | 3.0 ms | ~260× | heap Δ 18 MB → ~0.1 MB |
| Indexed nested-loop join 1000 | 10.4 ms | 0.081 ms | ~130× | no full right-side materialize |
| App queries / 200 users | 101 ms | 3.2 ms | ~32× | join probe + assignee index |
| Snapshot export ~1 MB | 29.2 ms | 2.6 ms | ~11× | growable `Uint8Array`, no `number[]` |
| Snapshot hydrate ~1 MB | 2.15 ms | 1.41 ms | ~1.5× | `replaceWith({ adopt: true })` |
| Snapshot round-trip 1 MB | 29.4 ms | 3.7 ms | ~8× | combined |
| CRUD loop | 19.3 ms | 8.4 ms | ~2.3× | PK lookups in the loop |
| Uncorrelated subquery PK | 6.6 ms | 0.17 ms | ~40× | eval subquery once |

Engine changes (semantics preserved; differential suite green):

- `IndexStore` supports non-unique multi-rowid entries and `lookup()`
- Equality `WHERE` / `UPDATE` / `DELETE` use INTEGER PRIMARY KEY maps or secondary indexes
- INNER/LEFT joins probe the right table via PK or index when `ON` is column equality
- Cached sorted `Table.scan()`
- Hash GROUP BY / DISTINCT
- Named-parameter token plan cached on `Statement`
- SQLM writer uses a growable `Uint8Array`; restore adopts decoded state
- Uncorrelated equality RHS (including scalar subqueries) evaluated once for access-path selection

### Phase 4 campaign (2026-08-30)

Copy-on-write and index-backed paths (differential + dual-path PBT green):

- **`Table.clone()`** shares `Row` references (and slab row refs materialized into the clone’s `rows` map) instead of `cloneRow` on every cell; first write in a transaction still forks via `update()`’s value slice or Map replacement.
- **`IndexStore.clone()`** shares entry maps until the first mutating op (`forkMaps()`); sorted-key cache invalidated on fork.
- **`IndexStore.lookupPrefix` / `rangeLookup`** use binary search on `orderedKeys()` + `keyValues` rather than linear scans over all entries.
- **FK checks** (`assertForeignKeyValues`, referential CASCADE/UPDATE) probe INTEGER PK / unique indexes on parent and child before falling back to heap scan.
- **`tryExecuteSimpleSelect`** handles indexed `ORDER BY col LIMIT n` (no `WHERE`) via `tryIndexedOrder`.

SQLM v3 persists `IndexStore` payloads (v1/v2 blobs still hydrate by rebuilding indexes). Public snapshot API is unchanged.

## Final results

### Bun (CI tier, sqlite-mem)

- Point lookup p50 / p95 / p99 (1000 rows, 20 ops): **0.047 / 0.058 / 0.058 ms**
- Prepared 1000 executes: **2.37 / 2.99 / 2.99 ms** (~400k/sec)
- Inserts/sec (1000 INTEGER PK + secondary index): **~237,000** (`hotspot/insert-pk/1000`; previously ~3,200 on the unconstrained TX insert bench)
- Snapshot 1 MB export p95 **2.6 ms** (~0.5 GB/s equivalent on this host); hydrate p95 **1.4 ms**

### Mobile (Chromium Moto G4, 4× throttle)

- PK lookup 1000 rows p95 **0.47 ms**
- Prepared 1000 executes p95 **9.4 ms** (~114k/sec)
- App queries p95 **12 ms**
- CRUD loop p95 **28 ms**
- Snapshot 1 MB export p95 **12 ms** (~89 MB/sec); hydrate p95 **8.2 ms** (~127 MB/sec)

### vs bun:sqlite (cost of pure TypeScript)

After the overhaul, PK lookups are about **4–5×** slower than native SQLite in Bun (was ~1000×). Batched INTEGER PK inserts with a secondary index are ~237k/sec on this host (~70× the previous ~3,200/sec TX insert bench), still well short of native insert parity (needs a row-representation rewrite). Snapshot export of ~1 MB is still slower than `serialize()` but no longer dominated by a JS `number[]` byte buffer.

### Bundle size

- uncompressed **395 KB**
- gzip **79 KB**
- brotli **65 KB**

## Phase 2 baseline (2026-08-19)

Recorded on **darwin arm64, Bun 1.3.14**. `bun run benchmark:ci` produced the numbers below, then correctly stopped at the platform guard because the committed `ci-baseline.json` is Linux. The Linux CI baseline still needs to be refreshed from the `ci-latest-linux` artifact; it was not overwritten with Darwin data.

| Benchmark | Phase 2 p50 | Phase 2 p95 | Throughput |
| --- | --- | --- | --- |
| Cold process + import + Database + first query | 23.31 ms | 24.51 ms | 43 starts/sec |
| Prepared PK executes ×20 | 0.139 ms | 0.395 ms | 102k executes/sec |
| Reparse + PK execute ×20 | 0.493 ms | 0.532 ms | 40.6k executes/sec |
| PK lookup / 1000 rows ×20 | 0.063 ms | 0.088 ms | 314k lookups/sec |
| Join small⋈large / 1000 | 0.034 ms | 0.071 ms | 26.3k queries/sec |
| Join small⋈large / 100,000 (full tier) | 0.121 ms | 0.241 ms | 6.8k queries/sec |
| Snapshot export / ~1 MB | ~1.97 ms mean | n/a (3 samples) | 507/sec |
| Snapshot hydrate / ~1 MB | ~1.15 ms mean | n/a (3 samples) | 868/sec |

The full tier now also includes an indexed 100,000-row JOIN. GROUP BY + aggregate coverage was already present at 1,000 rows (default) and 100,000 rows (full), so it was retained rather than duplicated.

Retained heap for 100,000 small rows was **94,323,119 bytes (943.2 bytes/row)**. Budgets are 130,000,000 bytes and 1,300 bytes/row.

Chromium with CDP 4× CPU throttle measured **0.60 ms p95** for 20 prepared PK lookups and **5.40 ms p95** for 1,000 prepared executes. Both pass the 3× smoke tolerance against `results/throttle-baseline.json`.

### Phase 2 measured optimization

`Table.allocateRowid()` previously scanned every existing rowid before each generated-rowid insert. A cached maximum now makes the monotonic case O(1); deleting the maximum invalidates the cache so SQLite's non-`AUTOINCREMENT` maximum-rowid reuse remains unchanged.

On `tx/batched-inserts/10000` (Darwin, default tier), the mean sample fell from **3.87 s to 1.95 s** (**49.6% lower**), while throughput rose from **2,582 to 5,133 inserts/sec** (**1.99×**). The remaining cost is constrained insert validation/index work.

The CI regression gate enforces a **2.5× p95** ceiling and a **1.50× median** ceiling (`BENCH_REGRESSION_FACTOR`, `BENCH_REGRESSION_MEDIAN`) for benches with reliable percentiles (n≥5) and a ≥2 ms absolute delta. n<5 samples (insert / snapshot roundtrip) skip ratio gates. On linux CI, `budgets.json` `ciMedianMs` still fail-closes on blowups (slack + 50 ms floor for n<5). Darwin `check:full` skips those timing ceilings (compare-ci already self-gates across OS). Sub-millisecond CI benches skip both ratio gates; few-ms micros skip the median gate and keep 2.5× p95.

## Target status

See [TARGETS.md](TARGETS.md). All listed mobile interactive / snapshot / bundle targets **PASS**.

Insert throughput for INTEGER PK + secondary index is **~70×** the previous ~3,200/sec TX insert bench via copy-on-write transactions and less Map churn. Native insert parity still needs a row-representation rewrite.

## Hotspot production pass (Bun, darwin)

Indexed range / prefix / `ORDER BY LIMIT` at 1000 rows are no longer scan-class:

| Spec | p95 | Notes |
| --- | --- | --- |
| `hotspot/range-gt/1000` | 0.36 ms | ~5× faster than unindexed scan (1.74 ms) |
| `hotspot/between/1000` | 0.08 ms | ordered IndexStore |
| `hotspot/order-limit/1000` | walks the index then LIMIT | not a full sort of all rows |
| `hotspot/index-prefix/1000` | binary search on ordered index keys | leftmost prefix of `(a,b)` |
| `hotspot/tx-begin/1000` | 0.03 ms | CoW: shared Row refs + shared IndexStore maps until first write |
| `hotspot/insert-pk/1000` | ~237k inserts/sec | ≥10× the previous ~3,200/sec TX insert bench |

CI records `benchmarks/results/ci-baseline.json`. The regression gate **fails closed** if that file was recorded on a different OS than the runner (GitHub Actions is linux). Re-record on ubuntu and commit the file (or download the `ci-latest-linux` workflow artifact).

## Snapshot Performance

SQLM v4 intern + columnar packing. The `1mb` corpus is 1000 identical 1 KB TEXT payloads, so intern collapses the blob (~22 KB) while live rows stay 1000 × 1 KB.

| | Baseline (pre-v4) | After (SQLM v4, Darwin arm64) |
| --- | --- | --- |
| Database | 1000 × 1 KB payload | same |
| Snapshot size | 1,051,507 B | ~22,529 B (interned TEXT) |
| Export | 4.2 ms median | 0.25 ms |
| Hydration (cold `encode`/`decode`) | 4.1 ms median | 0.22 ms |
| Round-trip | ~8 ms | ~1.8 ms |

**Incremental snapshots:** export always serializes the full database. A 1% row change still pays 100% export cost. Delta/incremental snapshots are a future opportunity, not implemented (architecture is full-state SQLM).

Fidelity: `snapshot/fidelity/200` plus `tests/contract/snapshots` and determinism snapshot tests pass.

## Test isolation (`open` vs migrate)

Per-test databases should `snapshot()` a frozen template once and `open()` per case. `Snapshot.encode()` / `Snapshot.decode(bytes).open()` is for persistence and worker boot; cold `exec` of a schema dump is the migrate proxy. Warm `decode` of the **same** `Uint8Array` object is CoW after the first hydrate. CI-tier, 200 users + 800 items, Bun 1.4.0 darwin arm64:

| Spec | p50 | p95 | ops/sec |
| --- | --- | --- | --- |
| `isolation/cold-migrate` | 5.7 ms | 7.6 ms | 165 |
| `isolation/decode-open` (warm) | 2.9 µs | 9.9 µs | 216k |
| `isolation/snapshot-open` | 1.9 µs | 3.5 µs | 415k |

`Snapshot.open()` is the per-test path (~3000× faster than migrate on this corpus). SQLM v4 stores compact index keys and interned TEXT so `decode(bytes).open()` still skips the O(n) index rebuild; the first decode of a buffer is cached on a WeakMap.

## Compatibility

- Full SQLite compatibility suite: **`bun run test:sqlite-compat`**
- Gate: **OK** (oracle 3.51.0)
- Tests: **727 pass, 0 fail** (contract + fuzz + harness)

## Remaining bottlenecks

1. **Insert / update row construction** — affinity, index maintenance, trigger/FK checks. Uniqueness uses `IndexStore` / autoindexes. Native insert parity needs a columnar/row-representation rewrite.
2. **BEGIN / SAVEPOINT** — copy-on-write: snapshots share frozen table row refs and index maps; clone on first write. Cheap on `hotspot/tx-begin/1000` (~0.03 ms). First write in a large TX still copies that table’s Map shell (not every cell).
3. **FK referential actions** — parent/child probes use PK and index lookup when keys align; heap scan remains fallback for non-indexed shapes.
4. **Row representation** — heap rows are `SqlValue[]` parallel to `table.columns`. Per-query `Cell[]` still dominate some full scans; SQLM v4 intern + columnar packing removes the 8–10× hydrate Map amplifier.
5. **FTS MATCH** still scans virtual-table rows (inverted index exists but is not the MATCH cursor path). Acceptable for small corpora; do not prioritize until product-critical.
6. **RIGHT/FULL joins** still nested-loop (INNER/LEFT equality joins use index probe or hash-join fallback)
7. **1M-row / 100 MB snapshot** cases are Bun/desktop-only; not claimed on throttled mobile

## Local-first guidance (JSON / FTS)

- **`json_extract` / `->>` / `json_set`** are cheap point ops (~tens of µs). Prefer them over expanding JSON into rows.
- **`json_each`** is intentionally expensive: it materializes relational rows from nested JSON. Avoid in hot paths. Prefer normalizing frequently queried fields, generated/materialized columns, or indexed extracts; reserve `json_each` for genuinely dynamic traversal.
- **FTS**: benchmark scaling is roughly linear in corpus size while MATCH filters after a virtual-table scan. Realistic search terms and result cardinality matter more than micro-optimizing FTS until it is on a critical path.

## Benchmark methodology notes

- Reports include **perOp** (`mean / opsPerSample`) so multi-op samples are comparable.
- When `iterations < 5`, p95/p99 are shown as **n/a** (mean marked with `~`) — do not treat those as percentile estimates.
- Stateful write benches use **`isolateIterations`** (fresh engine + setup per sample) so rows do not accumulate across iterations.
- Workload-c reports per-query timings (`userMs`, `projectMs`, `joinMs`) plus separate email-lookup and join-only cases.

## JS / SQLite engine comparison

Fair core micros against other engines (not a full SQLite-compatibility claim for AlaSQL):

```bash
bun run benchmark:compare          # both tracks, all available engines
bun run benchmark:compare-js       # sqlite-mem vs AlaSQL (dialect-safe)
bun run benchmark:compare-sqlite   # sqlite-mem vs bun:sqlite / sql.js / wa-sqlite
# → benchmarks/results/compare-js.json (+ .html)
```

### Dual tracks

| Track | Specs | Engines | Schema |
| --- | --- | --- | --- |
| **JS dialect** | `compare/js/*` | sqlite-mem, AlaSQL | `INT` / `STRING` (no INTEGER PRIMARY KEY) |
| **SQLite** | `compare/sqlite/*` | sqlite-mem, bun-sqlite, sql.js, wa-sqlite | `INTEGER PRIMARY KEY` + index on join key |

Ops (sizes 100 / 1000): id lookup, N inserts, equality join, prepared id executes.

Caveats:

- AlaSQL is **not** SQLite; the JS track uses a conservative dialect so both engines run the same SQL.
- On the JS track, sqlite-mem does **not** use its rowid PK fast path — see the SQLite track (or `micro/pk-lookup`) for peak point-lookup claims.
- “Prepared” for AlaSQL means `alasql.compile`; for sql.js / wa-sqlite it means real prepared statements (wa-sqlite’s API is async under the harness).
- In-memory AlaSQL transactions are best-effort; do not treat TX insert wins as durability batching.
- `alasql`, `sql.js`, and `wa-sqlite` are **devDependencies** only; the published package stays zero-runtime-deps. Missing packages are soft-skipped with a warning.

Stop condition: mobile interactive and 1 MB snapshot targets met without a bytecode VM or format break.
