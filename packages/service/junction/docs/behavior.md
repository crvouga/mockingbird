# Junction Lab behavior

## Domain model

- A user is the Junction patient identity and may have multiple orders.
- A lab test describes markers, partner laboratory, supported collection methods, and an orderable test ID.
- An order is one unit of laboratory work for one patient.
- An order transaction is the testing journey and groups an initial order with related orders such as redraws.
- A result may be partial while work is active and final when the transaction is completed.
- `sample_id` can be absent at creation and appear later.

## Ordering

1. Create or resolve the patient user.
2. Select a collection method supported by the lab test.
3. Confirm lab account, billing type, physician workflow, and patient information.
4. Create the order with an idempotency key.
5. Persist both `order.id` and `order_transaction.id`.
6. Treat `labtest.order.updated` as a notification and re-read the order before deciding what to do.

The same idempotency key must make a safe retry return the original order. Reusing a key with a different payload is a domain error and must not create a second order.

## Status semantics

`order.status` describes one order's operational state. The documented lifecycle includes values such as `received`, `collecting_sample`, `sample_with_lab`, and `completed`; the API may add values, so consumers must preserve unknown strings.

`order_transaction.status` describes the whole testing journey and is one of `active`, `completed`, or `cancelled` in the documented contract. A related redraw keeps the original transaction while retaining its own order status.

The low-level order status is more detailed and can include `ordered`, `requisition_created`, `transit_customer`, `out_for_delivery`, `with_customer`, `transit_lab`, `delivered_to_lab`, `completed`, `cancelled`, `partial_results`, `redraw_available`, `corrected`, and provider failure states. This list is non-exhaustive.

Cancellation and completion must update the order status, event history, last event, transaction summary, and low-level order projection together. Invalid transitions should be rejected or represented as a stable no-op according to the endpoint contract.

## Results

- Partial results can be available while an order or transaction is active.
- Final transaction results should be fetched after the transaction reaches `completed`.
- Transaction results combine findings from all related orders.
- Order-specific results and PDFs are separate concepts from transaction results.
- Unknown result statuses must not crash consumers.

The current mock returns deterministic structured synthetic markers. It does not represent real PHI, laboratory values, or PDFs.

## Webhooks

Every event has `event_type`, `data`, `team_id`, `user_id`, and `client_user_id`. Lab order events include `labtest.order.created` and `labtest.order.updated`.

Webhook delivery is at-least-once. Consumers must deduplicate and tolerate retries and out-of-order messages. A webhook is a notification that data changed; the API remains the source of truth.

Junction's documented retry schedule is eight attempts: immediate, 5 seconds, 5 minutes, 30 minutes, 2 hours, 5 hours, 10 hours, and another 10 hours. A 2xx response within roughly 15 seconds acknowledges delivery; non-2xx responses, redirects, and timeouts fail the attempt.

This mock exposes deterministic delivery records and can add seeded jitter around retry times so model-based tests exercise delayed, duplicate, and reordered delivery without becoming irreproducible.

## Operational behavior

- Sandbox and production have separate keys and team configuration.
- Lab coverage depends on modality, laboratory, and patient ZIP code.
- Junction may return 429 or 503 under infrastructure stress; idempotent requests should be retried with backoff.
- The mock does not emulate a global rate limit, but parity tests may inject provider delay and failure.
- API and webhook identifiers must be correlated with application identifiers by the consumer.
