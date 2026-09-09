# geviti → Junction coverage catalog

Every Junction (Vital) API interaction found in the
[geviti-monorepo](https://github.com/gogeviti/geviti-monorepo) lab-provider layer, and where
this mock covers it. Generated from a full-repo sweep of `@tryvital/vital-node` SDK usage,
direct `fetch` calls, webhook handlers, and dev-tools clients (September 2026).

## geviti call sites

| geviti location | What it does |
| --- | --- |
| `apps/backend/src/modules/lab-provider/lab-providers/junction/services/junction-appointment.service.ts` | Phlebotomy availability, book, get, reschedule via Vital SDK |
| `apps/backend/src/modules/lab-provider/lab-providers/junction/services/*` | Order creation, status reads, results, webhook intake |
| `apps/backend/src/modules/global-services/services/vital-services/vital.service.ts` | Legacy PSC availability/booking/cancel + cancellation reasons (direct fetch) |
| `apps/backend/src/modules/global-services/services/vital-services/vital-psc-appointment.ts` | PSC request/response Zod schemas |
| `apps/backend/src/modules/dev-tools/lib/vital-dev-tools-client.ts` | Order simulate (`/v3/order/{id}/test`) with `final_status`, `delay`, `simulationFlags` |
| Junction webhook handlers | `labtest.order.created`, `labtest.order.updated`, `labtest.appointment.updated` |

## Coverage matrix

| Operation | Endpoint | geviti usage | Mock | Differential parity | Scenario parity |
| --- | --- | --- | --- | --- | --- |
| Create user | `POST /v2/user` | SDK | modeled | yes | yes |
| List users | `GET /v2/user` | SDK | modeled | yes | — |
| Get user | `GET /v2/user/{id}` | SDK | modeled | yes | — |
| Resolve user | `GET /v2/user/resolve/{client_user_id}` | SDK | modeled | yes | — |
| Patch user | `PATCH /v2/user/{id}` | SDK | modeled | yes | — |
| Delete user | `DELETE /v2/user/{id}` | SDK | modeled | yes | yes (cleanup) |
| Patch user info | `PATCH /v2/user/{id}/info` | SDK | modeled | yes | — |
| Latest user info | `GET /v2/user/{id}/info/latest` | SDK | modeled | yes | yes |
| Lab test catalog | `GET /v3/lab_test`, `GET /v3/lab_tests/{id}` | SDK | synthetic | yes | yes |
| Labs list | `GET /v3/lab_tests/labs` | SDK | synthetic | yes | yes |
| Markers for lab test | `GET /v3/lab_tests/{id}/markers` | SDK | synthetic | yes | yes |
| Order-set markers | `POST /v3/lab_tests/list_order_set_markers` | SDK | synthetic | yes | — |
| Create order | `POST /v3/order` | SDK | modeled | yes | yes |
| Get order | `GET /v3/order/{id}` | SDK | modeled | yes | yes |
| List orders | `GET /v3/orders` | SDK | modeled | yes | — |
| Cancel order | `POST /v3/order/{id}/cancel` | SDK | modeled | yes | — |
| Simulate order | `POST /v3/order/{id}/test` | dev-tools fetch | modeled | yes | yes |
| Area serviceability | `GET /v3/order/area/info` | indirect (availability gate) | synthetic | yes | yes |
| PSC site info | `GET /v3/order/psc/info` | indirect | synthetic | yes | yes |
| Phlebotomy availability | `POST /v3/order/phlebotomy/appointment/availability` | SDK | synthetic | no (volatile) | yes |
| Book phlebotomy | `POST /v3/order/{id}/phlebotomy/appointment/book` | SDK | modeled | no (external state) | booked in live scenario |
| Get phlebotomy appointment | `GET /v3/order/{id}/phlebotomy/appointment` | SDK | modeled | no | yes |
| Reschedule phlebotomy | `PATCH /v3/order/{id}/phlebotomy/appointment/reschedule` | SDK | modeled | no | — |
| Cancel phlebotomy | `PATCH /v3/order/{id}/phlebotomy/appointment/cancel` | SDK | modeled | no | — |
| Phlebotomy cancellation reasons | `GET /v3/order/phlebotomy/appointment/cancellation-reasons` | SDK | synthetic | yes | yes |
| PSC availability | `POST /v3/order/psc/appointment/availability` | legacy fetch | synthetic | no (volatile) | — |
| Book PSC | `POST /v3/order/{id}/psc/appointment/book` | legacy fetch | modeled | no | — |
| Get PSC appointment | `GET /v3/order/{id}/psc/appointment` | legacy fetch | modeled | no | — |
| Reschedule PSC | `PATCH /v3/order/{id}/psc/appointment/reschedule` | legacy fetch | modeled | no | — |
| Cancel PSC | `PATCH /v3/order/{id}/psc/appointment/cancel` | legacy fetch | modeled | no | — |
| PSC cancellation reasons | `GET /v3/order/psc/appointment/cancellation-reasons` | legacy fetch | synthetic | yes | — |
| Raw results | `GET /v3/order/{id}/result` | SDK | synthetic | no (async processing) | — |
| Result metadata | `GET /v3/order/{id}/result/metadata` | SDK | synthetic | yes | yes |
| Result PDF | `GET /v3/order/{id}/result/pdf` | SDK | synthetic | no (signed URL) | — |
| Requisition PDF | `GET /v3/order/{id}/requisition/pdf` | SDK | synthetic | no (signed URL) | — |
| Order transaction | `GET /v3/order_transaction/{id}` | SDK | synthetic | no | — |
| Transaction results | `GET /v3/order_transaction/{id}/result` | SDK | synthetic | no | — |
| Webhook: order created/updated | callback | handlers | modeled | event names + shapes | yes |
| Webhook: appointment updated | callback | handlers | modeled | event names + shapes | yes |

## Tiered parity strategy

1. **Differential walker** (`bun run parity`): only the deterministic allowlist in
   `scripts/parity.ts` runs — users, catalog, orders, simulate, result metadata,
   serviceability, cancellation reasons. Resource-table canonicalization maps IDs and
   `x-mockingbird-volatile` fields.
2. **Scenario parity** (`scripts/client-parity-live.ts`): one full SDK scenario
   (user → catalog → serviceability → order → appointment reads → simulate) executed against
   mock and sandbox with a volatility-aware normalizer diffing each step.
3. **State-space suites**: `junction.scheduling.property.test.ts` and
   `junction.property.test.ts` exercise booking key single-use/expiry, idempotent PSC
   booking, cancel cascades, delayed simulate transitions, and result gating against the
   mock directly.

## Known real-side quirks the mock mirrors

- `POST /v3/order/{id}/test` returns `200 "Success"` (text/plain), not `204`.
- Phlebotomy cancel body is snake_case (`cancellation_reason_id`); PSC cancel is camelCase
  (`cancellationReasonId`). Reason "Other" requires a note.
- Booking keys are single-use and expire one hour before the slot start.
- PSC booking requires `site_code` and is lab-restricted (Quest in sandbox).
- Results are gated: empty until the order reaches `sample_with_lab`/`completed`.
- Getlabs rejects duplicate patient bookings on the same day — the mock keeps one active
  appointment per order instead.
