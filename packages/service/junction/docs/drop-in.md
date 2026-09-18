# Junction mock — drop-in readiness

This package is a stateful mock of the Junction (Vital) API's team-scoped user and
lab-testing surfaces. It is a **drop-in** for a consumer's e2e suite when the served mock
answers the same reads as the sandbox for parameter-stable operations, and when orders
round-trip the fields a consumer's sub-account resolver reads back.

Nothing here names a consumer: the mock exposes a generic hermetic mode and the
verification below is purely repo-local.

## Hermetic sealed corpus

Provider-owned geo inventory (area serviceability, PSC site lists, lab catalog, team labs,
lab accounts) is not synthesizable, so it is captured as an exact sandbox recording and
committed at `corpus/sandbox-sealed.json`.

Serialized reads the corpus covers only **parameter-stable GETs**:

- `GET /v3/order/area/info` (both `?zip_code=<z>&radius=100` and `?zip_code=<z>`)
- `GET /v3/order/psc/info` (with and without `radius`)
- `GET /v3/lab_test` (all pages), `GET /v3/lab_tests/labs`,
  `GET /v3/lab_tests/{id}/markers`, `GET /v3/lab_test/lab_account`

Availability is **not** recorded: sealed availability bodies carry far-future slot dates and
single-use `booking_key`s that can never match a live `start_date` cache key. Availability
stays with the deterministic generator.

Record once (requires a sandbox key — `~/.vault-token` or `MOCKINGBIRD_JUNCTION_API_KEY`):

```bash
cd packages/service/junction
bun run corpus:record            # writes corpus/sandbox-sealed.json
bun run corpus:record -- --force # overwrite an existing recording
```

Serve the mock with the corpus installed (`node:http` via the Node adapter; runs under
`bun` or `node`):

```bash
MOCKINGBIRD_JUNCTION_CORPUS=corpus/sandbox-sealed.json bun run mock:serve
# defaults: HOST=127.0.0.1 PORT=8787 (PORT=0 = ephemeral)
# defaults to corpus/sandbox-sealed.json when that file exists
```

Routes: `GET /health` → `{"status":"ok"}` and `POST /__admin/reset` → `await api.reset()`,
both matched before the API (so they bypass the `x-vital-api-key` gate). Everything else is
served by `JunctionAPI.fetch`. If `MOCKINGBIRD_JUNCTION_CORPUS` points at a missing file the
server prints `junction mock corpus not found: <path>` and exits non-zero.

Programmatic install (no filesystem, `dist` stays portable):

```ts
import { JunctionAPI, parseSealedCorpus } from "@crvouga/mockingbird-service-junction"

const api = new JunctionAPI()
api.installCorpus(parseSealedCorpus(JSON.parse(recording)))
```

`installCorpus` seeds the observation cache and replaces the catalog, labs, and lab accounts
with the recording's values; `api.reset()` re-applies the installed corpus.

## Drop-in proof commands

```bash
cd packages/service/junction

# Official-SDK drop-in: drives the served mock through @tryvital/vital-node
bun test junction.sdk.property.test.ts

# Corpus fidelity + cache-miss fallback + reset re-apply + parser validation
bun test junction.sealed-corpus.property.test.ts

# Served contract: /health, auth gate, /__admin/reset, webhook signing, missing-corpus exit
bun test junction.server.property.test.ts

# Live differential parity against the sandbox (the corpus is only a recording of parity truth)
bun run parity -- --runs 5 --steps 10
```

## Operation coverage

Operation ids mirror `SUPPORT.md` (generated from `openapi.yaml`). "Mock" is this package's
honest status; "parity" is whether the automated differential walks exercise it.

| operationId | mock | parity |
| --- | --- | --- |
| `get_teams_users_v2_user_get` | modeled | ✅ |
| `create_user_v2_user_post` | modeled | ✅ |
| `get_user_v2_user__user_id__get` | modeled | ✅ |
| `delete_user_v2_user__user_id__delete` | modeled | ✅ |
| `patch_user_v2_user__user_id__patch` | modeled | ✅ |
| `get_user_by_client_user_id_v2_user_resolve__client_user_id__get` | modeled | ✅ |
| `patch_user_info_v2_user__user_id__info_patch` | modeled | ✅ |
| `get_latest_user_info_user_v2_user__user_id__info_latest_get` | modeled | ✅ |
| `get_paginated_lab_tests_for_team_v3_lab_test_get` | corpus (else synthetic) | ✅ |
| `get_lab_accounts_v3_lab_test_lab_account_get` | corpus (else synthetic) | ❌ disabled |
| `get_lab_test_for_team_v3_lab_tests__lab_test_id__get` | corpus (else synthetic) | ✅ |
| `get_labs_v3_lab_tests_labs_get` | corpus (else synthetic) | ✅ |
| `get_markers_for_lab_test_v3_lab_tests__lab_test_id__markers_get` | corpus (else synthetic) | ✅ |
| `list_order_set_markers_v3_lab_tests_list_order_set_markers_post` | synthetic | ✅ |
| `create_order_v3_order_post` | modeled | ✅ |
| `get_area_info_v3_order_area_info_get` | corpus (else synthetic) | ❌ disabled |
| `get_psc_info_v3_order_psc_info_get` | corpus (else synthetic) | ❌ disabled |
| `get_phlebotomy_appointment_availability_v3_order_phlebotomy_appointment_availability_post` | generated | ❌ disabled |
| `get_phlebotomy_appointment_cancellation_reason_v3_order_phlebotomy_appointment_cancellation_reasons_get` | synthetic | ✅ |
| `get_psc_appointment_availability_v3_order_psc_appointment_availability_post` | generated | ❌ disabled |
| `get_psc_appointment_cancellation_reason_v3_order_psc_appointment_cancellation_reasons_get` | synthetic | ✅ |
| `get_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_get` | modeled | ❌ disabled |
| `book_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_book_post` | modeled | ❌ disabled |
| `reschedule_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_reschedule_patch` | modeled | ❌ disabled |
| `cancel_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_cancel_patch` | modeled | ❌ disabled |
| `get_psc_appointment_v3_order__order_id__psc_appointment_get` | modeled | ❌ disabled |
| `book_psc_appointment_v3_order__order_id__psc_appointment_book_post` | modeled | ❌ disabled |
| `reschedule_psc_appointment_v3_order__order_id__psc_appointment_reschedule_patch` | modeled | ❌ disabled |
| `cancel_psc_appointment_v3_order__order_id__psc_appointment_cancel_patch` | modeled | ❌ disabled |
| `get_order_v3_order__order_id__get` | modeled | ✅ |
| `cancel_order_v3_order__order_id__cancel_post` | modeled | ✅ |
| `simulate_order_v3_order__order_id__test_post` | modeled | ✅ |
| `get_result_raw_v3_order__order_id__result_get` | synthetic | ❌ disabled |
| `get_result_metadata_v3_order__order_id__result_metadata_get` | synthetic | ✅ |
| `get_result_pdf_v3_order__order_id__result_pdf_get` | synthetic | ❌ disabled |
| `get_order_requisition_pdf_v3_order__order_id__requisition_pdf_get` | synthetic | ❌ disabled |
| `get_orders_v3_orders_get` | modeled | ✅ |
| `get_order_transaction_v3_order_transaction__transaction_id__get` | synthetic | ❌ disabled |
| `get_order_transaction_result_v3_order_transaction__transaction_id__result_get` | synthetic | ❌ disabled |

Parity-disabled rows fall into three buckets: provider-owned geo inventory (now served from
the sealed corpus, still excluded from the walker because a recording is not a walk), values
that shift between sandbox calls (availability, appointment payloads), and provider-rendered
bytes (result/requisition PDFs). Each is covered by a mock-internal property suite instead.

## Sandbox quirks the mock mirrors

- `POST /v3/order/{id}/test` returns `200 "Success"` (`text/plain`), not `204`.
- Phlebotomy cancel body is snake_case (`cancellation_reason_id`); PSC cancel is camelCase
  (`cancellationReasonId`). Reason "Other" requires a note.
- Booking keys are single-use and expire one hour before the slot start.
- PSC booking requires `site_code` and is lab-restricted (Quest in sandbox).
- Results are gated: empty until the order reaches `sample_with_lab`/`completed`.
- The at-home provider (Getlabs) rejects duplicate patient bookings on the same day — the
  mock keeps one active appointment per order instead.
- Order `lab_account_id` is an opaque provider-assigned string (not a UUID) and round-trips
  verbatim on read; orders created without one omit the field from the response.

## Confidence gate

Drop-in readiness is claimed only when every command above is green.
