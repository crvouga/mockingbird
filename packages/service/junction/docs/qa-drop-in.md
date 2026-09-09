# Geviti QA → Junction drop-in coverage matrix

Living checklist: the mock is a **drop-in** for Geviti only when every row that
`packages/qa` exercises is `monkey-green` under seedParity against
`api.sandbox.tryvital.io`.

Status legend:

- `unproven` — QA uses it; not yet in seedParity allowlist or not exercised green
- `in-allowlist` — included in `scripts/parity.ts` QA_WEIGHTED_OPS; still expanding
- `monkey-green` — seedParity walks exercise it without divergence (replay + broader runs)

Re-sweep `geviti-monorepo/packages/qa` when adding Vital call sites.

## Must-have — CI goldens / routing

| Junction op | QA use | Status |
| --- | --- | --- |
| `get_area_info_v3_order_area_info_get` | baseline probe, routing corpus, address validate | in-allowlist |
| `get_psc_info_v3_order_psc_info_get` | walk-in sites, lab finder, routing pins | in-allowlist |
| `get_order_v3_order__order_id__get` | post-checkout routing (`labAccountId`, lab slug) | in-allowlist |
| `create_user_v2_user_post` / resolve / get | checkout + reconcile patient | in-allowlist |
| `create_order_v3_order_post` | place order / ensure-order | in-allowlist |
| `cancel_order_v3_order__order_id__cancel_post` | cancel flows | in-allowlist |
| `get_orders_v3_orders_get` | list / ground truth | in-allowlist |
| Catalog (`lab_test`, labs, markers) | products / orphan fallback | in-allowlist |

## UI / scheduling / lifecycle

| Junction op | QA use | Status |
| --- | --- | --- |
| `simulate_order_v3_order__order_id__test_post` | simulate webhook / ready-to-book | in-allowlist |
| Phlebotomy availability / book / get / reschedule / cancel | UI schedule drawer | in-allowlist (availability, book, get) |
| PSC appointment lifecycle | legacy vital-bloodwork | unproven |
| `get_result_raw` / `get_result_pdf` | results download | in-allowlist (raw); pdf unproven |
| `get_result_metadata` | metadata after simulate | in-allowlist |
| Cancellation reasons (phleb + PSC) | cancel UI | in-allowlist |

## Reconcile / dev-tools / hygiene

| Junction op | QA use | Status |
| --- | --- | --- |
| List + delete users | prune / purge 50-user cap | in-allowlist |
| Orphan create + cancel-at-vital | reconcile edge helpers | in-allowlist (via create/cancel) |

## Proof engine

```bash
# Default: seed parity (warmup N → seedFrom → compare M)
bun run parity
bun run parity -- --warmup 15 --compare 30 --runs 25

# Legacy empty-start differential
bun run parity -- --mode=empty
```

Offline monkey (no network): `junction.seed.property.test.ts` — mockA warmup →
`seedFrom` → lockstep mockB.

Do **not** claim drop-in or flip Geviti `packages/qa` onto the mock until this
matrix is fully `monkey-green`.
