# postgres-mem Performance

## Environment

- CPU: host Darwin arm64 for local Bun benches; CI gate uses linux `ci-baseline.json`
- Memory: Bun `process.memoryUsage()`
- Runtime: Bun 1.4.0

```bash
bun run benchmark
bun run benchmark:ci
```

## Test isolation (`open` vs migrate)

Per-test databases should `snapshot()` a frozen template once and `open()` per case. `Snapshot.encode()` / `Snapshot.decode(bytes).open()` is for persistence and worker boot; cold `exec` of a schema dump is the migrate proxy. Warm `decode` of the **same** `Uint8Array` object is CoW after the first hydrate. CI-tier, 200 users + 800 items, Bun 1.4.0 darwin arm64:

| Spec | p50 | p95 | ops/sec |
| --- | --- | --- | --- |
| `isolation/cold-migrate` | 32 ms | 80 ms | 25 |
| `isolation/decode-open` (warm) | 7.5 µs | 0.34 ms | 15k |
| `isolation/snapshot-open` | 3.8 µs | 9.1 µs | 201k |

`Snapshot.open()` is the per-test path (thousands of times faster than migrate on this corpus). `pg_catalog` stays virtual (not in PGMM). JavaScript `registerFunction` impls are not in PGMM bytes — register on the seed DB, then `snapshot().open()`.

PGMM v2 intern + columnar cells: the `snapshot/export/1mb` corpus (1000 identical 1 KB TEXT payloads) encodes at ~14.5 KB and cold-hydrates in ~0.4 ms (was ~1 MB / 1.7 ms).
