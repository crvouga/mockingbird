# Junction Lab support matrix

Status meanings:

- **Modeled** — behavior is represented by the local API and tested directly.
- **Synthetic** — shape and lifecycle are modeled, but values are deterministic fixtures.
- **Planned** — useful contract behavior identified but not yet implemented.
- **Out of scope** — intentionally excluded from this Lab-focused service.

| Area | Status | Local surface | Notes |
| --- | --- | --- | --- |
| API-key authentication | Modeled | `src/index.ts` | Requires `x-vital-api-key`. |
| User create/read/list/resolve/update/delete | Modeled | `src/users.ts` | SQLite-backed deterministic user lifecycle. |
| User demographics/info | Modeled | `src/users.ts` | Merge semantics. |
| Latest user info | Modeled | `src/users.ts` | `GET /v2/user/{id}/info/latest`; 404 until info is patched. |
| Lab test catalog | Synthetic | `src/catalog.ts`, `src/orders.ts` | Fixed catalog and marker fixtures. |
| Labs list | Synthetic | `src/orders.ts` | `GET /v3/lab_tests/labs`. |
| Markers (lab test + order set) | Synthetic | `src/orders.ts` | Paginated `GetMarkersResponse` shape as the SDK expects. |
| Collection-method details | Synthetic | `src/orders.ts` | Test-kit, walk-in, and generic method shapes. |
| Idempotent order creation | Modeled | `src/orders.ts` | Same key replays the original response. |
| Idempotency conflict detection | Modeled | `src/orders.ts` | Rejects key reuse with a changed request body. |
| Order read/list/cancel/sandbox simulation | Modeled | `src/orders.ts` | Consistent event/transaction/low-level projections. |
| Simulate delay + simulation flags | Modeled | `src/orders.ts` | `delay` queues a lazy transition; flags project onto orders/results. |
| Order event history | Modeled | `src/state.ts` | Local event history; status vocabulary is open-ended. |
| Order transactions | Synthetic | `src/orders.ts` | One initial order; related-order grouping is planned. |
| Area serviceability | Synthetic | `src/scheduling.ts` | `GET /v3/order/area/info` with phlebotomy + central-labs sections. |
| PSC site info | Synthetic | `src/scheduling.ts` | `GET /v3/order/psc/info` with site metadata and capabilities. |
| Phlebotomy/PSC availability | Synthetic | `src/scheduling.ts` | Deterministic seeded slots with expiring booking keys. |
| Appointment booking (phlebotomy/PSC) | Modeled | `src/scheduling.ts` | Single-use keys, modality-bound, PSC `site_code` + idempotency. |
| Appointment get/reschedule/cancel | Modeled | `src/scheduling.ts` | Cancel reason validation; cascade from order cancel. |
| Cancellation reasons | Synthetic | `src/scheduling.ts` | Same fixture list as the sandbox. |
| Partial/final structured results | Synthetic | `src/results.ts` | Gated on draw status; simulation flags respected. |
| Result metadata | Synthetic | `src/results.ts` | `GET /v3/order/{id}/result/metadata`. |
| Result/requisition PDFs | Synthetic | `src/results.ts` | Minimal deterministic `%PDF-` bytes. |
| Lab accounts and team configuration | Synthetic | `src/state.ts` | Fixed team identifier fixture. |
| Webhook envelope | Modeled | `src/state.ts` | Standard top-level fields are preserved. |
| Webhook persistence | Modeled | `src/state.ts` | Events are retained in SQLite order. |
| Webhook retries and delivery attempts | Modeled | `src/state.ts` | Seeded schedule with optional jitter. |
| Webhook signatures/Svix headers | Out of scope | — | Delivery transport is callback-based in this package. |
| Rate limiting and 429/503 fault injection | Planned | — | Useful for parity but not part of the baseline mock. |
| Wearables, Sense, Connect, Management API, ETL | Out of scope | — | See the Junction documentation index for those products. |

The matrix is deliberately explicit: unsupported behavior should fail clearly or remain absent rather than return a misleading successful response.
