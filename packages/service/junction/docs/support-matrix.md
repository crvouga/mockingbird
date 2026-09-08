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
| User demographics/info | Modeled | `src/users.ts` | Merge semantics; latest read endpoint is planned. |
| Lab test catalog | Synthetic | `src/catalog.ts`, `src/orders.ts` | Fixed catalog and marker fixtures. |
| Collection-method details | Synthetic | `src/orders.ts` | Test-kit, walk-in, and generic method shapes. |
| Idempotent order creation | Modeled | `src/orders.ts` | Same key replays the original response. |
| Idempotency conflict detection | Planned | `src/orders.ts` | Must reject key reuse with a changed request body. |
| Order read/list/cancel/sandbox simulation | Modeled | `src/orders.ts` | Transition consistency is being expanded. |
| Order event history | Modeled | `src/state.ts` | Local event history; status vocabulary is open-ended. |
| Order transactions | Synthetic | `src/orders.ts` | One initial order currently; related-order grouping is planned. |
| Partial/final structured results | Synthetic | `src/orders.ts` | Deterministic markers; no PDF payload. |
| Result PDFs and order-specific result endpoints | Out of scope | — | Not required by the selected Lab slice. |
| Lab accounts and area coverage | Out of scope | — | Team configuration is fixture-based. |
| Webhook envelope | Modeled | `src/state.ts` | Standard top-level fields are preserved. |
| Webhook persistence | Modeled | `src/state.ts` | Events are retained in SQLite order. |
| Webhook retries and delivery attempts | Planned | `src/state.ts` | Seeded scheduling is the next implementation slice. |
| Webhook signatures/Svix headers | Out of scope | — | Delivery transport is callback-based in this package. |
| Rate limiting and 429/503 fault injection | Planned | — | Useful for parity but not part of the baseline mock. |
| Wearables, Sense, Connect, Management API, ETL | Out of scope | — | See the Junction documentation index for those products. |

The matrix is deliberately explicit: unsupported behavior should fail clearly or remain absent rather than return a misleading successful response.
