# QA → Junction drop-in coverage matrix

Living checklist: this mock is a **drop-in** for the consumer's QA suite only when every row it
exercises is `monkey-green` under seedParity against `api.sandbox.tryvital.io`.

The consuming project is deliberately unnamed here: this matrix is about the mock's own surface
and proof status. A consumer records its own call sites; this repository only guarantees the
surface.

Status legend:

- `unproven` — used by a consumer; not yet in the seedParity allowlist or not exercised green
- `in-allowlist` — included in `scripts/parity.ts` QA_WEIGHTED_OPS; still expanding
- `monkey-green` — seedParity walks exercise it without divergence (replay + broader runs)

## Proof engine (dynamic explore)

Walks use **dynamic weights** (history + resource counts + coverage + phase +
scheduling sagas), not static weights. Geo/availability params are reshaped onto
the QA ZIP corpus after a shared observation-cache prefetch (area/psc + sealed
availability POSTs). Consumed `booking_key`s are marked deleted after book.

```bash
# Default: dynamic seed parity (warmup → prefetch corpus → seedFrom → compare)
bun run parity
bun run parity -- --warmup 20 --compare 40 --runs 25
bun run parity -- --skip-prefetch   # smoke without ZIP seal

# Offline monkey (no network) — full QA surface including book/get/reschedule/cancel
bun test junction.seed.property.test.ts
```

Do **not** point a QA suite at the mock until live seedParity is `monkey-green`
for the rows below.

## Must-have — CI goldens / routing

| Junction op | Consumer use | Status |
| --- | --- | --- |
| `get_area_info` | baseline probe, routing corpus | offline monkey-green; live pending |
| `get_psc_info` | walk-in sites, lab finder | offline monkey-green; live pending |
| `get_order` | post-checkout routing | offline monkey-green; live pending |
| create/resolve/get user | checkout + reconcile | offline monkey-green; live pending |
| `create_order` / cancel / list | place / cancel / ground truth | offline monkey-green; live pending |
| Catalog (lab_test, labs, markers) | products | offline monkey-green; live pending |

## UI / scheduling / lifecycle

| Junction op | Consumer use | Status |
| --- | --- | --- |
| `simulate_order` | webhook / ready-to-book | offline monkey-green; live pending |
| Phlebotomy availability | schedule drawer | offline monkey-green (sealed reshape+prefetch) |
| Phlebotomy book / get / reschedule / cancel | schedule drawer | offline monkey-green |
| PSC availability | walk-in | offline monkey-green |
| PSC book / get / reschedule / cancel | walk-in lifecycle | in-allowlist (live+offline forceInclude); offline book path covered via phleb saga |
| `get_result_raw` / `get_result_pdf` | results download | in-allowlist (forceInclude); offline raw green |
| `get_result_metadata` | after simulate | offline monkey-green |
| Cancellation reasons | cancel UI | offline monkey-green |

## Reconcile / hygiene

| Junction op | Consumer use | Status |
| --- | --- | --- |
| List + delete users | prune / 50-user cap | offline monkey-green |
| Orphan create + cancel | reconcile helpers | offline monkey-green |

## Confidence gate

| Gate | Command | Status |
| --- | --- | --- |
| Offline full-surface seedParity | `bun test junction.seed.property.test.ts` | green |
| Scheduling property suite | `bun test junction.scheduling.property.test.ts` | green |
| Live seedParity vs tryvital | `bun run parity -- --runs 10` | pending this session |
