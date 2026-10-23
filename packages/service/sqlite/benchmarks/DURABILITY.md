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

Snapshot encoding and image comparison still scale with image size. Collection inserts and
autocommit writes also retain native Map-copy costs. These are measured workloads for small
datasets, not a claim of universal WASM/OPFS parity.

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
now the largest sampled cost; full snapshot encoding/comparison also remains linear in image
size. The final 33-workload report passes all budgets, including the sql.js comparisons.

The dense IndexedDB case also guards a browser-specific amplification: structured cloning a
TypedArray page view preserves its entire backing buffer. A 1 MiB image split into 64 views
previously submitted 64 MiB of backing storage to clone. The adapter now compacts borrowed
views before `put`, submitting 1 MiB in total. Existing compact pages need no extra copy.
The gate measures the actual buffer sizes passed to the object store, and real WebKit
verification reads all 64 stored pages back and requires exactly 1 MiB of backing buffers.
The emulated dense timing includes acknowledgement of one 64-page transaction but is a CPU
benchmark, not a measurement of physical browser storage latency.

## Verification

The shared backend suite covers changed-page selection, image growth/truncation/re-paging,
empty images, separate keys, concurrent revision conflicts, invalid/missing pages, quota
failures, abort after queued page writes, retries and response acknowledgement ordering.
Database integration tests cover schema/index/blob recovery, transaction rejection/rollback,
prepared handles after saves and bounded history retention. Shared collection tests cover
namespace isolation, restore, rollback and sequence continuation after recovery. The existing
differential SQL contract/fuzz suites remain the compatibility authority.
