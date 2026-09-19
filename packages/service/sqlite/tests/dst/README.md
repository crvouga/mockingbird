# Deterministic simulation testing (DST)

Dump-after-each differential simulation lives under `tests/fuzz/dst/`:

| Module | Role |
| --- | --- |
| `tests/fuzz/dst/engine.ts` | Dual-engine runner (B-tuple + Dump) |
| `tests/fuzz/dst/ops.ts` | Mixed / DML op vocabulary |
| `tests/fuzz/dst/minimize.ts` | Shrink a failing sequence to SQL |
| `tests/fuzz/dst/repro.ts` | Write corpus / local shrink artifacts |

## Random walk

State-dependent walk under `tests/fuzz/walk/` (Antithesis-style): at each step
the model computes **enabled** actions, a decision vector picks among them, and
both engines assert result + logical-state parity.

```bash
bun run test:walk
SQLITE_MEM_WALK_STEPS=80 SQLITE_MEM_FUZZ_SEED=12345 bun run test:walk
bun run test:walk:soak -- --depth 200 --runs 20
```

## Replay

```bash
SQLITE_MEM_FUZZ_SEED=1511514337 bun test tests/fuzz/mixed-stateful.test.ts
SQLITE_MEM_FUZZ_SEED=1511514337 SQLITE_MEM_FUZZ_PATH='0:1' bun test tests/fuzz
```

## Promote a minimized repro

```bash
# After a failure, write an artifact:
#   tests/dst/repros/<slug>.sql  (via writeDstReproArtifact)
bun run scripts/promote-fuzz-repro.ts --slug my-bug --from tests/dst/repros/mixed-….sql
```

Committed forever under `tests/corpus/regressions/` (replayed by `tests/fuzz/corpus.test.ts`).

## Soak overrides

```bash
SQLITE_MEM_MIXED_STEPS=64 SQLITE_MEM_STATEFUL_STEPS=64 SQLITE_MEM_WALK_STEPS=64 SQLITE_MEM_FUZZ_RUNS=100 bun run test:fuzz:soak
```
