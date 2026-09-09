# Junction Lab behavior

## Domain model

- A user is the Junction patient identity and may have multiple orders.
- A lab test describes markers, partner laboratory, supported collection methods, and an orderable test ID.
- An order is one unit of laboratory work for one patient.
- An order transaction is the testing journey and groups an initial order with related orders such as redraws.
- An appointment is a scheduled sample collection: at-home phlebotomy or a patient service center visit. An order has at most one active appointment.
- A booking key is a single-use, expiring token representing one available slot. It is returned by availability endpoints and consumed by booking.
- A result may be partial while work is active and final when the transaction is completed.
- `sample_id` can be absent at creation and appear later.

## Scheduling

Availability is generated deterministically from the zip code, start date, and provider (or
PSC site codes), so identical inputs return identical slots on independent mock instances.

1. Check serviceability (`GET /v3/order/area/info`) and, for PSC, site info
   (`GET /v3/order/psc/info`).
2. Request availability. Phlebotomy takes the patient address in the body; PSC takes
   `lab=quest` plus optional `zip_code`/`site_codes` in the query.
3. Book with a `booking_key` from the availability response. PSC booking additionally
   requires `site_code` and honors `x-idempotency-key` replays.
4. Booking moves the order to the modality-specific `appointment_scheduled` event, sets the
   appointment to `status: confirmed` / `event_status: scheduled`, and emits
   `labtest.appointment.updated` plus a `labtest.order.updated` webhook.
5. Reschedule consumes a new unclaimed booking key for the same modality; cancelled
   appointments refuse reschedule. Cancel requires a valid cancellation reason id
   (snake_case `cancellation_reason_id` for phlebotomy, camelCase `cancellationReasonId`
   for PSC) and, for the "Other" reason, a note.
6. Cancelling the order cascades to its active appointment.

Booking keys are single-use, modality-bound, and expire one hour before the slot start.
Unknown, consumed, expired, or wrong-modality keys are rejected with `400`. The mock keeps
one active appointment per order, mirroring real provider duplicate-booking protection.

## Ordering

1. Create or resolve the patient user.
2. Select a collection method supported by the lab test.
3. Confirm lab account, billing type, physician workflow, and patient information.
4. Create the order with an idempotency key.
5. Persist both `order.id` and `order_transaction.id`.
6. Treat `labtest.order.updated` as a notification and re-read the order before deciding what to do.

The same idempotency key must make a safe retry return the original order. Reusing a key with a different payload is a domain error and must not create a second order.

## Status semantics

`order.status` describes one order's operational state as a top-level value: `received`,
`collecting_sample`, `sample_with_lab`, `completed`, `cancelled`, or `failed`. The dotted
three-part status (`received.walk_in_test.ordered`) lives on order events and
`last_event.status`; the API may add values, so consumers must preserve unknown strings.

`order_transaction.status` describes the whole testing journey and is one of `active`, `completed`, or `cancelled` in the documented contract. A related redraw keeps the original transaction while retaining its own order status.

The low-level order status is more detailed and can include `ordered`, `requisition_created`, `transit_customer`, `out_for_delivery`, `with_customer`, `transit_lab`, `delivered_to_lab`, `completed`, `cancelled`, `partial_results`, `redraw_available`, `corrected`, and provider failure states. This list is non-exhaustive.

Cancellation and completion must update the order status, event history, last event, transaction summary, and low-level order projection together. Invalid transitions should be rejected or represented as a stable no-op according to the endpoint contract.

## Sandbox simulation

`POST /v3/order/{id}/test?final_status=<dotted-status>` drives transitions. It accepts
`delay` (seconds) — the transition is queued and applied lazily on later reads once the
clock passes `due_at` — and an optional `simulationFlags` body (`interpretation`,
`result_types`, `has_missing_results`) that is projected onto the order and results when
the call advances state. The real API responds `200` with the JSON body `"Success"`, and
the mock matches.

Observed sandbox semantics (api.sandbox.tryvital.io):

- The **first** `/test` on a fresh order always creates
  `received.{collection_method}.requisition_created` (method is taken from the order, not
  the requested `final_status` prefix).
- **`at_home_phlebotomy`**: further `/test` calls are no-ops (including `completed` /
  `cancelled` / simulation flags) until the order advances by other means (e.g. booking).
- **`walk_in_test`** after requisition:
  - matching `appointment_*` / `requisition_created` → no-op
  - matching `partial_results` → append `sample_with_lab.walk_in_test.partial_results`
  - matching `ordered` / `completed` / `cancelled`, or any mismatched-method status →
    jump through `partial_results` then `completed` (sets `interpretation` default
    `normal` plus expected/worst result dates)
  - `failed.*` → append the failed status

## Results

- Partial results can be available while an order or transaction is active; the mock returns
  an empty result set until the order reaches `sample_with_lab` or `completed`.
- Final transaction results should be fetched after the transaction reaches `completed`.
- Transaction results combine findings from all related orders.
- Order-specific results and PDFs are separate concepts from transaction results.
- Unknown result statuses must not crash consumers.
- Simulation flags surface in results: `interpretation` on every line plus metadata,
  `result_types` selecting each line's `type` (numeric/range/comment/coded_value), and
  `has_missing_results` populating `missing_results`.
- PDFs (`/result/pdf`, `/requisition/pdf`) are minimal deterministic `%PDF-` documents —
  enough for content-type and byte-shape checks, not renderable reports.

The current mock returns deterministic structured synthetic markers. It does not represent real PHI, laboratory values, or real PDFs.

## Webhooks

Every event has `event_type`, `data`, `team_id`, `user_id`, and `client_user_id`. Lab order events include `labtest.order.created` and `labtest.order.updated`; appointment lifecycle changes emit `labtest.appointment.updated` with the appointment payload.

Webhook delivery is at-least-once. Consumers must deduplicate and tolerate retries and out-of-order messages. A webhook is a notification that data changed; the API remains the source of truth.

Junction's documented retry schedule is eight attempts: immediate, 5 seconds, 5 minutes, 30 minutes, 2 hours, 5 hours, 10 hours, and another 10 hours. A 2xx response within roughly 15 seconds acknowledges delivery; non-2xx responses, redirects, and timeouts fail the attempt.

This mock exposes deterministic delivery records and can add seeded jitter around retry times so model-based tests exercise delayed, duplicate, and reordered delivery without becoming irreproducible.

## Operational behavior

- Sandbox and production have separate keys and team configuration.
- Lab coverage depends on modality, laboratory, and patient ZIP code.
- Junction may return 429 or 503 under infrastructure stress; idempotent requests should be retried with backoff.
- The mock does not emulate a global rate limit, but parity tests may inject provider delay and failure.
- API and webhook identifiers must be correlated with application identifiers by the consumer.
