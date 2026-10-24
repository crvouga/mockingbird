# Browser durability and storage performance

Durability is opt-in and shared through the `DurabilityBackend` port. Existing synchronous
database and service APIs keep their signatures and defaults. Both database packages expose
`openDurableDatabase`, the adapters, the generic `openDurable` codec/controller and `withDurability`.

IndexedDB commits changed binary pages and metadata in one transaction, with a revision check
to reject competing writers. The default durability hint is `strict`; acknowledgement waits
for `complete`, not for the last request's `success`. See the [IndexedDB transaction options](https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction).
localStorage is a fallback for small images: it replaces one base64 image atomically, uses
Web Locks when available and otherwise requires one writer per key. Storage quotas and browser
eviction still apply.

Use one awaited save per batch. A save still encodes and compares the full SQLM/PGMM image;
only changed pages go to IndexedDB. It is O(database size), with a default 16 KiB page size.
This is a small-dataset alternative to WASM SQLite, not a SQLite file format, pager or OPFS VFS.
The results below do not establish performance parity with every OPFS implementation or SQL
workload. PostgreSQL has its own execution costs and is not a drop-in SQLite dialect.

## What changed

- SQLite's integer primary key already uses the row-id map. Removing its second, redundant
  full-table uniqueness scan makes repeated inserts linear rather than quadratic.
- The single-row insert path now handles simple integer primary keys and NOT NULL columns,
  with the full executor retained for conflicts and complex constraints. Values use positional
  arrays. Differential tests compare errors, counters and state between both paths.
- Shared service collections retain their bounded set of prepared statements, eliminating
  repeated parsing for reads, writes and sequence allocation across the emulator catalog.
- Both index stores share maps/buckets across forks, detach a map on its first write and copy
  only mutated buckets. Repeated inserts into an owned bucket still append in place.
  PostgreSQL index forks become O(1); SQLite's first write still copies its native maps.
- SQLite table clones use native Map construction, retain immutable scan caches and defer
  hydrated slab materialization until mutation. Durable saves do not retain timeline checkpoints.
- Durability batches encoding/IO, uses binary pages without base64 in IndexedDB, skips unchanged
  images, removes old tail pages directly, and releases connections owned by database handles.

## Reproduce the measurements

From the repository root after `bun run setup`:

```sh
# Actual previous/current storage implementations, no branch or worktree changes:
bun packages/service/sqlite/benchmarks/storage-compare.ts --baseline 5ef4b657

# Existing engine comparison, including sql.js and wa-sqlite under Bun:
cd packages/service/sqlite
bun benchmarks/run.ts --tier ci --engine compare-sqlite --grep compare/sqlite/

# Real browser: open the printed localhost URL, then reload to prove persistence:
bun benchmarks/durability-browser.ts
```

`storage-compare.ts` substitutes the five changed storage/executor source files from the
specified Git revision into a baseline bundle, then compares that bundle to the checkout.
It runs three warmups followed by nine samples and reports medians. Setup is outside the
timed section; row validation and close remain inside it for both versions. Use an idle machine
for comparisons and retain the raw JSON rather than treating one ratio as a universal claim.

The browser harness checks every lookup result, saves 100-update transactions, reopens both
SQL engines through both adapters, and reports values left by prior page loads. It uses the
published browser bundles and real browser storage. It measures sql.js for runtime comparison;
it does not measure a WASM OPFS durability backend. Its built-in insert times are individual
batches rather than statistically stable percentiles.

## Observed storage results

[Raw storage comparison](results/durability-storage.json), Bun 1.4.2 on macOS arm64 against
`5ef4b657`, nine samples after three warmups. This run followed completion of repository gates.
The baseline and current bundles run in that order in one process, so JIT/GC and machine effects
still apply. These isolate the changed storage paths rather than representing every SQL query.

| Workload | Previous median | Current median | Improvement |
| --- | ---: | ---: | ---: |
| 1,000 integer-PK inserts, one transaction | 96.45 ms | 1.71 ms | 56× |
| 10,000 integer-PK inserts, one transaction | 2,356.80 ms | 16.35 ms | 144× |
| 10,000 shared-collection point reads | 179.67 ms | 28.49 ms | 6.3× |
| 100 SQLite index forks plus one write each, 10,000 keys | 106.58 ms | 11.34 ms | 9.4× |

One hundred read-only PostgreSQL index forks over 10,000 keys went from about 41 ms to below
0.01 ms, reflecting the new O(1) clone. This is a synthetic clone-only measurement; mutations
and actual SQL work still have their own costs.

## Observed browser results

See [raw browser results](results/durability-browser.json). WebKit 605.1.15, Safari 18.5 user
agent, macOS. The pane ran in the background alongside repository validation, so timing
outliers are substantial; these are workload observations, not latency budgets.

| Workload | Mockingbird SQLite | sql.js |
| --- | ---: | ---: |
| Prepared point read, 1,000 rows (median per operation) | 2.8 µs | 10.6 µs |
| Prepared point read, 10,000 rows (median per operation) | 1.0 µs | 11.0 µs |
| Insert 1,000 rows in one transaction (single batch) | 8 ms | 4 ms |
| Insert 10,000 rows in one transaction (single batch) | 10 ms | 6 ms |

At 1,000 stored rows, a batch of 100 updates plus an awaited strict IndexedDB save had a
9 ms median for SQLite and 36 ms for PostgreSQL. The localStorage medians were 8 ms and
33 ms. They include SQL execution, snapshot encoding/comparison and storage acknowledgement;
they are not isolated storage throughput measurements. Initial-save timings were noisy and
should not be used as performance claims. Both engines recovered all rows/updates through
both adapters, including across repeated browser reloads.

## Automated regression gate and profiling

From the repository root:

```sh
# All 33 workloads, correctness checks and regression budgets:
bun run performance

# Focused investigation (the default command still enforces budgets):
bun run performance -- --only postgres/update-batch/10000

# Compare with a saved report from the same Bun/platform/architecture:
bun run performance -- --baseline .performance/baseline.json

# Native Bun CPU sampling, with a validated three-second workload loop:
bun run performance:profile -- --only postgres/durable-memory/10000

# Published browser bundles, real IndexedDB/localStorage and page reload recovery:
bun run performance:browser
```

`scripts/performance/` measures prepared point reads, transactional and autocommit updates,
inserts, durable batches at 1,000/10,000 rows, shared service collections, and an 8 MiB image
with one changed page. Numeric and Unicode/text snapshot cases encode ten fresh 10,000-row
snapshots per sample, avoiding the cached-encode shortcut and reducing timer noise. It runs
three warmups and nine samples, reports median/p95, and saves
`.performance/latest.json`. Setup, final row verification, recovery checks and cleanup are
outside the timed section. Every point-read result is checked inside the timed loop; writes
verify all resulting rows, including untouched rows. Fresh insert fixtures prevent sample
sizes from growing. `--samples` accepts at least five samples for a gate; `--out` saves a
named report. SQL.js uses prepared statements and matching transaction boundaries as a
same-process WASM runtime reference. Phase timings in `details` are diagnostic means across
warmups and measured iterations; they are not components of the reported median.

For an implementation comparison without changing branches, retain baseline bundles before
editing, then pass their directory to the same harness:

```sh
bun build packages/service/sqlite/src/index.ts --target=bun --outdir .performance/before/sqlite
bun build packages/service/postgres/src/index.ts --target=bun --outdir .performance/before/postgres
bun scripts/performance/run.ts --modules .performance/before --out .performance/before.json
```

Omitting `--check` records a diagnostic baseline even when older code exceeds new work-count
limits. Correctness verification still runs and failures still exit nonzero. Benchmark matching
before/after bundles on an idle machine; do not compare different sample sizes or case definitions.

`bun run check` and the PR Static job include this gate. CI uploads `.performance/` as the
`emulator-performance` artifact even on failure. Timings are never served from Turbo's cache.
The checked-in budgets include headroom for CI, same-run WASM ratios and deterministic work
limits: point queries must use bounded candidate visits, untouched PostgreSQL tuples must
retain their identity, and payload-only collection updates must avoid index forks. Durable
fixtures also require exactly one atomic commit per changed batch and reopen every saved
image. Collection writes retain immutable table/index schema objects until a schema edit.
The sparse-image case requires exactly one changed page and at most 16 KiB of encoded-buffer
copies, rather than copying the entire 8 MiB image. Optional baseline comparison
rejects missing workloads and runtime/platform mismatches.

The gate tests launch a deliberately de-indexed update with `--canary-scan`; it must fail on
100,000 candidate visits versus a limit of 400. This exercises the actual workload and command
exit status, independently of clock noise. Probes run separately from timings and do not add
instrumentation to production code.

CPU profiles are Markdown files under `.performance/profiles/`. The initial profile found
evaluation-scope construction and sets dominating PostgreSQL updates: an indexed predicate
still visited every row. After fixing that path, profiling exposed deep table/xmin cloning,
index-map copying, and temporary BigInt allocation during snapshot encoding. The changes now:

- materialize only matching tuples for eligible point reads and updates, preserving residual
  predicates and conservative fallbacks for complex SQL;
- share immutable PostgreSQL tuples across DML snapshots, detach for in-place schema changes,
  and retain the trigger-safe deep-copy fallback;
- keep unchanged index entries, retaining the existing ordering for duplicate/NULL buckets;
- encode numeric integers directly into identical wire bytes, and compare snapshot words
  exactly rather than byte by byte.

The [recorded optimization report](../../../../scripts/performance/results/optimization.json)
contains raw before/after results, diagnostic profile summaries and the automated browser
reload results. Observed medians on Bun 1.4.2/macOS arm64:

| Workload | Before | After |
| --- | ---: | ---: |
| PostgreSQL: 5,000 point reads, 10,000 rows | 1,484.49 ms | 12.10 ms |
| PostgreSQL: 100 transactional point updates, 10,000 rows | 247.62 ms | 1.02 ms |
| PostgreSQL: 100 updates plus memory save, 10,000 rows | 314.34 ms | 1.95 ms |
| Exact sparse diff/save of an 8 MiB image | 17.08 ms | 3.80 ms |
| Shared collection: 100 payload updates, 1,000 records | 5.12 ms | 2.18 ms |

Before/after were separate processes on the same machine. The initial exploratory run overlapped
profiling in its early workloads; the table selects later cases after profiling ended, plus a
separate isolated collection measurement. JIT, GC and machine load still affect timing: these
are observations, not portable guarantees. The updated PostgreSQL probe visits 100 candidate
rows for 100 point updates, down from 1,000,000, with zero deep copies of untouched tuples.
The final durable profile is dominated by encoding rather than the former full-table update
scan. It includes setup and verification as well as the workload loop.

Real browser automation uses documented `sc` browser commands. It requires browser automation
to be enabled and the workspace granted access; it reuses only its benchmark tab. The mandatory
CI suite instead uses `fake-indexeddb` for adapter correctness/CPU measurements. Those timings
do **not** represent physical browser IO latency. The browser command validates both engines
and both adapters, then reloads and checks counters from the previous page. To run outside
super.engineering, serve `benchmarks/durability-browser.ts` manually as described above.

Snapshot encoding and image comparison still scale with image size. At this stage, collection
inserts and transaction forks also retained native Map-copy costs; the large-table pass below
addresses those copies. These measurements do not establish universal WASM/OPFS parity.

## Further allocation reductions

The next profiling pass found schema `structuredClone` calls and native Map construction
dominating collection inserts. DML now shares immutable SQLite table/index metadata, with
deep detachment before schema edits in either branch. Ordinary DML row scopes follow column
order directly instead of sorting and repeatedly searching column names. Prepared execution
retains callbacks that already read the current database PRNG, including after restore.

Both encoders reserve packed numeric/text-id column regions once, rather than checking/growing
the writer for every cell. UTF-8 strings are encoded once for lengths and content instead of
twice. PostgreSQL no longer builds an xmin array during the string-only interning pass, and
retains only values that can contribute interned strings for its second pass. Golden SHA-256
fixtures from the previous encoder pin SQLM/PGMM bytes for numeric boundaries, null bitmaps,
floats, binary, Unicode, repeated strings, arrays and JSON.

The generic durability controller compares the borrowed codec output synchronously, copies
only dirty pages before awaiting storage, and updates its private comparison image only after
a successful commit. Sparse writes reuse that image when its size is unchanged; dense,
initial and resized writes own the full image once to avoid extra reconstruction. Unchanged
flushes copy no encoded bytes. Failed commits, unaligned views and codec buffers mutated while a commit is
pending are covered by tests; Buffer inputs also use an owning TypedArray copy.

The [further optimization report](../../../../scripts/performance/results/further-optimization.json)
records both retained bundles, their SHA-256 hashes, all 33 before/after workloads, paired
timing diagnostics and real browser reload results. Paired medians on Bun 1.4.2/macOS arm64,
five warmups and 31 samples per implementation with alternating before/after order:

| Workload | Before | After | Latency reduction |
| --- | ---: | ---: | ---: |
| 1,000 shared-collection inserts | 40.82 ms | 26.28 ms | 36% |
| PostgreSQL: ten numeric snapshots, 10,000 rows each | 7.16 ms | 4.76 ms | 33% |
| SQLite: ten Unicode/text snapshots, 10,000 rows each | 49.56 ms | 36.57 ms | 26% |
| PostgreSQL: ten Unicode/text snapshots, 10,000 rows each | 54.53 ms | 40.94 ms | 25% |
| PostgreSQL: 100 updates plus memory save, 10,000 rows | 1.77 ms | 1.28 ms | 28% |
| Sparse diff/save of an 8 MiB image | 8.48 ms | 4.61 ms | 46% |

These are incremental gains over the preceding optimization pass. The paired process retains
both implementations' fixtures, so GC/memory pressure and absolute timings differ from the
separate-process CI reports. Allocation/work limits provide the hardware-independent evidence:
sparse codec-buffer copies fall from 8 MiB to 16 KiB, and collection writes copy zero table or
index schema objects. In the diagnostic insert profile, `structuredClone` falls from 14.6%
of self samples to below the profiler's displayed 0.1% precision. Native Map construction is
the largest sampled cost in that profile; full snapshot encoding/comparison also remains linear in image
size. The final 33-workload report passes all budgets, including the sql.js comparisons.

The dense IndexedDB case also guards a browser-specific amplification: structured cloning a
TypedArray page view preserves its entire backing buffer. A 1 MiB image split into 64 views
previously submitted 64 MiB of backing storage to clone. The adapter now compacts borrowed
views before `put`, submitting 1 MiB in total. Existing compact pages need no extra copy.
The gate measures the actual buffer sizes passed to the object store, and real WebKit
verification reads all 64 stored pages back and requires exactly 1 MiB of backing buffers.
The emulated dense timing includes acknowledgement of one 64-page transaction but is a CPU
benchmark, not a measurement of physical browser storage latency.

## Large-table transactions and range reads

`bun run performance:production` runs 20 additional workloads at 100,000 rows, including
sql.js runtime references. `bun run check` and the PR Static job run these alongside the
original 33 cases. Setup, verification and cleanup are excluded from timings; each fixture
checks its final rows, index lookups or persisted/reopened state. Work-count probes fail on
whole-table reference copies or excessive range candidate visits, independently of CPU speed.
Profile a case with:

```sh
bun run performance:profile -- --only postgres/production/rollback/100000
```

The shared core now supplies an insertion-ordered persistent map. Forks share hash directories,
native hash buckets and 32-way order pages; writes detach only their bucket and order path.
The directory has 1,024 buckets, so bucket-copy cost still depends on size and hash distribution.
This trades additional entry/directory memory for smaller transaction copies. Maps below 4,096
entries retain native storage. SQLite uses this for row/clustered stores and both engines use it
for large index maps. PostgreSQL point updates share their base row-reference array and keep
sparse tuple replacements in a persistent map. Scans, structural edits and public Map/Array
access materialize native containers; existing public field identity and mutation behavior remain
covered by compatibility tests.

Bounded numeric SQLite predicates seek an index interval and retain residual filtering for
exclusive endpoints and additional predicates. PostgreSQL adds conservative bounded int2/int4
access through simple unique indexes, retaining heap order before projection. Unsupported
types, expressions and query shapes use the existing executor. Ordered caches are invalidated
when keys change and remain isolated across forks. Pure derived PostgreSQL indexes survive
rollback in the frozen source, avoiding repeated rebuilds; expression/partial indexes and
triggers retain their evaluation order. DDL detaches shared cell arrays, and repeated savepoint
restore keeps catalog maps independent. SQLM/PGMM snapshot formats remain unchanged.

The [large-table report](../../../../scripts/performance/results/production-optimization.json)
records retained-bundle hashes, raw standalone results, alternating paired measurements,
diagnostic profile summaries and both real-browser page loads. Paired medians on Bun 1.4.2,
macOS arm64, five warmups and 21 samples per implementation, all at 100,000 rows:

| Workload | Before | After | Speedup |
| --- | ---: | ---: | ---: |
| SQLite: 100 individual transactions | 33.96 ms | 0.86 ms | 39× |
| SQLite: 100 individual transactions changing an indexed key | 291.06 ms | 2.17 ms | 134× |
| PostgreSQL: 100 individual transactions changing an indexed key | 113.13 ms | 1.69 ms | 67× |
| SQLite: ten bounded range reads | 849.75 ms | 0.81 ms | 1,048× |
| PostgreSQL: ten bounded range reads | 304.57 ms | 0.47 ms | 644× |
| PostgreSQL: 100 indexed updates, nested savepoint and rollback | 48.93 ms | 1.32 ms | 37× |

For 100 steady-state individual transactions, whole-table reference copies fall from 10 million
to zero in each engine. SQLite instead detaches 9,817 hash entries; PostgreSQL detaches seven
in its sparse replacement map. Initial conversion/index construction is outside those counts.
Ten range probes fall from 1 million visits to 330 SQLite candidates (including closed interval
endpoints) and 640 PostgreSQL accesses (counting both rowAt and native-array reads). These are
warm caches; the first sort/index build remains proportional to the data. The small native-map
cases stayed within about seven percent of their paired baseline medians in this run; the
results do not establish uniform improvements across all workloads or machines.

Real WebKit also preserves 100,000 rows in both engines across close/reopen and page reload,
including independent historical branches. Each measured group runs 100 indexed single-row
transactions followed by **one awaited IndexedDB save**. First-page medians were 100 ms for
SQLite and 26 ms for PostgreSQL; the second page measured 64 ms and 12 ms respectively.
The reload verifies that each prior value advances by exactly the expected one million.

The sql.js comparison is an in-memory WASM runtime reference. Grouped updates still trail
sql.js: the standalone 100-update transaction measured 2.05 ms SQLite / 1.12 ms PostgreSQL /
0.11 ms sql.js. Snapshot encode/compare remains linear in image size, and the browser results
use batched durability acknowledgements. Neither the emulated IndexedDB timings nor the real
browser recovery checks establish OPFS performance parity, general multi-session server
concurrency, or production suitability for every workload.

## Opt-in buffered incremental persistence

`openBufferedDurableDatabase` is available from both SQL packages. It keeps SQL synchronous,
coalesces mutations by physical row identity, and schedules persistence 1,000 ms after the first
unsaved change. The deadline does not slide with continuing writes. Suspended tabs can delay
it; this mode accepts loss of recent unacknowledged work. Use one writer per database key.
The new factory's owned IndexedDB adapter uses relaxed durability. The existing
`openDurableDatabase` and adapter constructor retain their strict defaults.

```ts
import { openBufferedDurableDatabase } from "@crvouga/mockingbird-service-sqlite";

const durable = await openBufferedDurableDatabase({
  key: "main",
  flushIntervalMs: 1000,
  onError: error => console.error("Background save failed", error),
});
durable.value.exec("CREATE TABLE IF NOT EXISTS counters(id INTEGER PRIMARY KEY, n INTEGER)");
durable.value.exec("INSERT INTO counters VALUES (1,0) ON CONFLICT(id) DO UPDATE SET n = n + 1");
await durable.flush(); // explicit acknowledgement when needed
await durable.close(); // flush first, then release the handle
```

Ordinary saves capture only changed rows/tombstones and small schema/runtime metadata. Values
use the existing SQLM/PGMM codecs, including numeric/binary types; PostgreSQL uses stable private
row IDs and retains xmin. Trigger/function results are physical values, not SQL to reexecute.
Counters, PRNG/clock, sequences, prepared/session metadata and supported schema state accompany
the rows. Repeated changes to one key produce one final value per capture. The shared controller
serializes storage commits while later SQL mutations remain pending; acknowledgement clears only
the captured versions. Independent journal forks keep rollback from mutating comparison tokens.

The MBDJ v1 envelope contains a complete checkpoint plus checksummed append frames. Atomic
backend page writes advance the persisted byte length and revision. The controller retains only
the last append page, so sparse saves do not scan/diff the existing image or rewrite its header.
Recovery validates the envelope and applies physical records, then rebuilds derived indexes.
Both current openers read old raw snapshots and new envelopes. An immediate writer opening an
envelope retains a complete checkpoint envelope so richer runtime metadata survives. Existing
raw keys stay raw unless explicitly opened in buffered mode; `Snapshot.encode/decode` formats
are unchanged.

Compaction replaces the journal after 256 successful delta batches or journal growth reaching
`max(4 MiB, checkpoint size)`; `compactAfterBatches` and `compactAfterBytes` override these
thresholds. Schema/opaque mutations select checkpoints. Public raw state/native Map/Array access,
borrowed binary query results, PostgreSQL binary parameters and registered host callbacks select
a conservative full-checkpoint fallback because retained references can mutate outside SQL.
Expression/partial SQLite indexes also use that fallback. Buffered mode inherits the snapshot
codec's coverage; it does not add persistence for attached/virtual-table data. LocalStorage shares
the protocol but still performs synchronous whole-image base64 rewrites; IndexedDB is the path
for incremental IO.

`pending` reports unacknowledged mutations/queued work. `lastError` and `onError` expose IO/quota
failures, which keep pending state for bounded-backoff retries. Revision conflicts stop the
background writer; reopen to reconcile. Explicit `write`, `flush` and `close` await acknowledgement
and reject on failure. Active SQL transactions defer background work and reject explicit saves.
Close via the durability handle; closing the raw engine cancels its timer and cannot acknowledge
unsaved changes. Page-hide saves are best effort, not an unload guarantee.

The reusable `openBufferedDurable` controller depends on `IncrementalDurabilityCodec`,
`DurabilityScheduler`, `DurabilityLifecycle` and the existing `DurabilityBackend` port. SQL-specific
row tracking stays in engine adapters. Default in-memory databases do not install a journal,
background scheduler or lifecycle listener.

```sh
# Twelve 100,000-row cases, including the immediate writer as a control:
bun run performance:buffered

# Optional million-row sparse-save scale check:
bun run performance:buffered -- --rows 1000000 --only sparse-flush --samples 5

# Diagnose capture, encoding, allocation and IO separately:
bun run performance:profile -- --only postgres/buffered/sparse-flush/100000

# Real IndexedDB acknowledgement, autonomous timer save and page reload recovery:
bun run performance:browser
```

The gate separates enqueue-only SQL, sparse/batched/coalesced acknowledged saves, and recovery.
After initial checkpoint/index construction, sparse saves require zero full snapshot encodes,
zero unchanged-row serialization, and at most 64 KiB of submitted page bytes. A deliberate
full-snapshot canary must fail these work limits. `bun run check` runs the twelve cases alongside
the existing 33 general and 20 large-table workloads. Fake IndexedDB isolates CPU/work counts;
real browser runs verify actual asynchronous transactions, 100,000-row recovery and an autonomous
one-second timer save before any explicit flush/close. The reload must retain that exact value.

The [buffered optimization report](../../../../scripts/performance/results/buffered-optimization.json)
retains all twelve raw 100,000-row results, million-row checks, browser page loads, layout
experiments, default-runtime diagnostics and profile summaries. Isolated Bun 1.4.2/macOS arm64
measurements, three warmups and nine samples (five samples for the million-row check):

| One-row update + acknowledged save | Immediate writer | Buffered writer | Speedup |
| --- | ---: | ---: | ---: |
| SQLite, 100,000 rows | 16.16 ms | 0.178 ms | 91× |
| PostgreSQL, 100,000 rows | 18.63 ms | 0.261 ms | 71× |
| SQLite, 1,000,000 rows | 327.56 ms | 2.27 ms | 144× |
| PostgreSQL, 1,000,000 rows | 308.65 ms | 0.976 ms | 316× |

These comparisons use the two openers in the same source revision, the same relaxed fake
IndexedDB adapter and matching SQL/transaction boundaries. They measure ordinary delta saves
after checkpoint/index construction, excluding periodic compaction. They are CPU/queue/adapter
measurements, not physical disk latency. Sparse saves serialize one changed SQLite row or
three PostgreSQL row visits across codec passes, with zero unchanged-row serialization and
zero full snapshot encodes. Full checkpoints and recovery still scale with database size.

Real WebKit measured groups of 100 indexed transactions plus one awaited IndexedDB save at
9/6 ms (SQLite/PostgreSQL) on the first page and 4/5 ms after reload. Both engines separately
saved an extra mutation through their autonomous timer, before any flush/close, and recovered
exactly 11 then 22 across the two loads. Maximum observed submitted bytes were below 22 KiB;
there were no full snapshot encodes during observed buffered saves. These results establish
recovery for this workload, not universal WASM/OPFS or server concurrency parity.

The layout experiment retained 32×32 buckets. Larger layouts improved synthetic forks but did
not meet the required combination of a clear real-SQL write gain and repeatable read/scan
stability. The default runtime installs durability execution hooks only on buffered statements;
ordinary prepared execution has no per-call observer checks. Mixed-process default-runtime
comparisons had GC/JIT variance (including small SQLite transaction slowdowns); fresh-process
100,000-row read/scan pairs showed no repeated regression above five percent across three
rounds, with one PostgreSQL point-read outlier. All raw rounds remain in the report.

PostgreSQL CPU sampling moves from packed-column encoding, materialization and full-image page
comparison toward adapter key handling, cloning and iteration. The buffered profile includes
initial/recovery work and periodic compaction; profile iteration counts are not the steady-save
benchmark. Performance gates retain their work-count budgets and deliberately fail on a forced
full-snapshot fallback.

## Verification

The shared backend suite covers changed-page selection, image growth/truncation/re-paging,
empty images, separate keys, concurrent revision conflicts, invalid/missing pages, quota
failures, abort after queued page writes, retries and response acknowledgement ordering.
Database integration tests cover schema/index/blob recovery, transaction rejection/rollback,
prepared handles after saves and bounded history retention. Shared collection tests cover
namespace isolation, restore, rollback and sequence continuation after recovery. The existing
differential SQL contract/fuzz suites remain the compatibility authority.
