# Performance targets

Targets were set **after** measuring the unoptimized baseline on 2026-08-17, not invented beforehand.

## Target hardware / runtime

- Historical low-end mobile proxy (targets below): Chromium + `Moto G4` + **4× CPU throttle** (measured once; not re-run in CI)
- Interactive local-first DB: schema with users/projects/tasks, **100–1000 rows** hot working set
- Snapshots: **~1 MB** hydrate/export as the critical mobile path (larger sizes are Bun/desktop)

## Query latency (mobile profile, sqlite-mem)

| Workload | Metric | Baseline p95 | Target p95 | Status |
| --- | --- | --- | --- | --- |
| PK lookup, 1000 rows (20 lookups) | p95 | 34 ms | < 2 ms | PASS (0.47 ms) |
| Unique index lookup, 1000 rows | p95 | ~34 ms | < 2 ms | PASS (0.60 ms) |
| Prepared 1000 PK executes | p95 | 1578 ms | < 50 ms | PASS (9.4 ms) |
| Local-first CRUD loop ×50 | p95 | 56 ms | < 50 ms | PASS (28 ms) |
| Indexed app queries (200 users) | p95 | 356 ms | < 50 ms | PASS (12 ms) |
| Indexed join small⋈large 1000 | p95 | 39 ms | < 5 ms | PASS (0.68 ms) |
| Schema + first query | p95 | 1.3 ms | < 5 ms | PASS (1.65 ms) |

## Throughput (mobile)

| Operation | Baseline | Target | Status |
| --- | --- | --- | --- |
| Point lookups/sec (PK, 1000 rows) | ~600 | > 20,000 | PASS (~86k) |
| Prepared executes/sec | ~640 | > 20,000 | PASS (~114k) |
| Inserts/sec (1000 in a transaction) | ~1,100 | ≥ baseline (insert path not rewritten) | SUPERSEDED — INTEGER PK + secondary index ~237k/sec on Bun (`hotspot/insert-pk/1000`) |

## Snapshots (1 MB payload DB, mobile)

| Metric | Baseline | Target | Status |
| --- | --- | --- | --- |
| Export p95 | 100 ms | < 30 ms | PASS (12 ms) |
| Hydrate p95 | 7.4 ms | < 20 ms | PASS (8.2 ms) |
| Export MB/sec | ~10 | > 30 | PASS (~89) |
| Hydrate MB/sec | ~143 | > 50 | PASS (~127) |
| Format | SQLM v3 (v1/v2 still hydrate) | no fidelity loss | PASS |

## Bundle

| Metric | Baseline | Target | Status |
| --- | --- | --- | --- |
| `dist/index.js` uncompressed | 383 KB | no large new deps | PASS (395 KB) |
| gzip | 76 KB | < 100 KB | PASS (79 KB) |
| brotli | 63 KB | < 90 KB | PASS (65 KB) |

## Memory

Chrome `performance.memory` on this profile is quantized (~10 MB) and is not a reliable peak gauge. Bun heap deltas for 1 MB snapshot export stay on the order of a few MB after the growable `Uint8Array` writer (previously a `number[]` byte builder). Target: **no multi-copy `number[]` snapshot buffer**. PASS.

Hydration adopts decoded state (no extra `DatabaseState.clone()`). Target: **peak amplification from an extra full clone on restore = removed**. PASS.

The Phase 2 retained-heap workload inserts 100,000 small `(INTEGER, TEXT)` rows. On darwin arm64 with Bun 1.3.14 it measured **94,323,119 bytes**, or **943.2 bytes/row**. `budgets.json` allows 130,000,000 bytes / 1,300 bytes per row (about 38% headroom) to absorb GC and allocator variance while still catching a new per-row copy or container.

Run `bun run benchmark:memory`; CI runs the same fail-closed budget check.

## Regression gates

- p95 must remain within `BENCH_REGRESSION_FACTOR` (default **2.5×**) of the same-platform baseline, with a ≥2 ms absolute delta.
- Median must remain within `BENCH_REGRESSION_MEDIAN` (default **1.50×**) for reliable (n≥5) benches whose baseline median is ≥12 ms (or p95 ≥25 ms), also with a ≥2 ms delta.
- n<5 samples skip ratio gates (p50/p95 are one sample on insert / snapshot roundtrip). On **linux CI**, `budgets.json` `ciMedianMs` still fail-closes on blowups (with slack + a 50 ms floor). Darwin `check:full` skips those ceilings — they are not comparable across OS, and compare-ci already self-gates.
- Sub-millisecond CI benches skip both ratio gates (shared runners flap ~1.5–2×).
- Sub-50µs measurements retain the existing absolute-noise exemption.
- `bun run test:browser` applies Chromium **4× CPU throttle** and checks PK lookup / prepared execution p95 against `results/throttle-baseline.json` with a **3×** smoke tolerance.

## Hotspot targets (Bun, after production pass)

Measured on darwin arm64 Bun 1.3.14; CI gate uses linux numbers from `ci-baseline.json`.

| Workload | Target | Status |
| --- | --- | --- |
| Indexed `WHERE created_at > ?` / 1000 | not scan-class; <10× bun:sqlite | PASS vs unindexed scan (~5× faster) |
| Leftmost prefix `INDEX(a,b)` / 1000 | not scan-class | PASS |
| `ORDER BY indexed LIMIT 50` / 1000 | not scan-class | PASS (index walk + LIMIT) |
| `BEGIN` on 1000-row DB | not a full row clone | PASS (~0.03 ms) |
| 1000 INTEGER PK + secondary index inserts | ≥10× ~3,200/sec | PASS (~237k/sec) |

## How to re-measure

```bash
bun run benchmark          # Bun, default tier
bun run benchmark:ci       # CI suite + p95/median regression gates + memory budget
bun run benchmark:bun      # full tier + bun:sqlite comparison
bun run benchmark:bundle   # dist sizes
bun run test:browser       # built ESM in Chromium with 4× CPU throttle
```
