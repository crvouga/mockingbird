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
| Team-level lab accounts | Modeled | `src/lab-accounts.ts` | Fixture inventory with the documented `ClientFacingLabAccount` shape, `lab_account_id`/`status` filters and `allowed_billing` maps. |
| Lab-account order routing + billing | Modeled | `src/orders.ts` | The four documented selection branches when `lab_account_id` is omitted; explicit ids must be active, team-linked and lab-matching; `billing_type` must be supported by the used account with the patient's state listed and `commercial_insurance` needs ICD codes. |
| Org-level lab-account management + insurance records | Out of scope | — | Requires an Org-scoped key (Get Lab Accounts org-wide, Update Lab Account Teams); insurance records are not modelled, so `commercial_insurance` enforces only the ICD-code requirement. |
| Webhook envelope | Modeled | `src/state.ts` | Standard top-level fields are preserved. |
| Webhook persistence | Modeled | `src/state.ts` | Events are retained in SQLite order. |
| Webhook retries and delivery attempts | Modeled | `src/state.ts` | Seeded schedule with optional jitter. |
| Webhook signatures/Svix headers | Modeled | `src/webhooks.ts` | Standard Svix signing when `webhooks` is configured. |
| Webhook emit (`POST /__admin/webhooks/emit`) | Synthetic | `src/wearable-webhooks.ts` | `labtest.*`, `provider.connection.*`, `daily.data.*`, `historical.data.*` for modelled resources; best guess, not oracle-verified (#758). Undocumented `lab_report.redraw_separate_pdf*` / `provider.wellness_visit` answer 400. |
| Rate limiting and 429/503 fault injection | Planned | — | Useful for parity but not part of the baseline emulator. |
| Wearables: Link token, providers, connections, refresh, deregister | Synthetic | `src/wearables.ts` | Best guess, not oracle-verified (#757); connections come from `POST /__admin/users/{id}/connections`. |
| Wearables: activity/sleep/sleep_cycle/body/meal summaries, sleep/body raw | Synthetic | `src/wearables.ts` | Deterministic per user, provider and day. |
| Wearables: grouped timeseries (steps, distance, calories_active, body_weight, body_fat, heartrate, hrv, glucose) | Synthetic | `src/wearables.ts` | One page; other documented resources answer 501. |
| Other wearables data (workouts, devices, profile, ECG, …), Sense, Connect, Management API, ETL | Out of scope | — | See the Junction documentation index for those products. |

The matrix is deliberately explicit: unsupported behavior should fail clearly or remain absent rather than return a misleading successful response.
