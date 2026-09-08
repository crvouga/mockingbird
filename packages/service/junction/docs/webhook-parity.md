# Junction webhook parity receiver

Junction webhook parity verifies that the real Junction sandbox and the mock publish identical webhook events (same set, same order, same exact payloads) after each parity walk. It needs a reachable receiver. The receiver is a Cloudflare Worker with a stable `workers.dev` URL and a Durable Object that keeps events isolated by parity run ID.

## Optional by default

Webhook event parity is **optional**. If `MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL` is unset, `bun run parity:junction` prints a warning and runs the regular API parity without webhook event checks. It never silently treats zero events as a valid result, and it never fails because webhook parity is not configured.

To enable webhook parity:

```sh
bun run webhook:deploy
export MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL="$(deployed workers.dev URL)"
bun run webhook:register   # health-checks the receiver and prints the webhook URL + event types to configure
bun run parity:junction
```

The only required variable is:

- `MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL` — deployed Worker base URL, for example `https://mockingbird-junction-webhooks.<account>.workers.dev`.

Cloudflare Wrangler credentials (`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`) are needed only to deploy the Worker.

## Local setup

From `packages/service/junction`:

```sh
bun run webhook:dev
```

For live Junction delivery, the local receiver must be reachable from the public internet. Use the stable deployed `workers.dev` receiver for parity, or provide a temporary public proxy and set `MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL` to that URL.

## Deploy and register

```sh
bun run webhook:deploy
export MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL="https://mockingbird-junction-webhooks.<account>.workers.dev"
bun run webhook:register
```

`webhook:register` health-checks the receiver at `/health` and prints the exact webhook URL to register in the Junction sandbox dashboard:

```text
https://mockingbird-junction-webhooks.<account>.workers.dev/junction/webhooks
```

plus the event types to enable:

```text
labtest.order.created
labtest.order.updated
```

Registration is dashboard-driven and does not require a Junction Management API key, organization ID, or team ID.

## Receiver contract

- `GET /health` — readiness probe.
- `POST /junction/webhooks` — receives Junction events. The request must include `x-mockingbird-scope`; the receiver stores the exact JSON payload in arrival order.
- `GET /events/{runId}` — returns the ordered events for one parity run.
- `DELETE /events/{runId}` — clears one run's events.

Run IDs isolate parallel parity processes. The parity runner compares real and mock events by count, order, and exact payload, and logs only event counts and event types.

## Smoke testing

Before live parity, verify the Worker:

```sh
curl -fsS "$MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL/health"
curl -i -X POST "$MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL/junction/webhooks" \
  -H 'content-type: application/json' \
  -H 'x-mockingbird-scope: smoke-test' \
  -d '{"event_type":"labtest.order.created"}'
curl -fsS "$MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL/events/smoke-test"
```

Then run:

```sh
bun run webhook:register
MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL="https://mockingbird-junction-webhooks.<account>.workers.dev" bun run parity:junction
```

## Troubleshooting

- `junction webhook parity: skipped; configure MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL ...` — the warning parity prints when webhook parity is off. Deploy the receiver, set the URL above, register the webhook URL and event types in the Junction sandbox dashboard, then rerun.
- `junction webhook receiver returned <status>` — the receiver is configured but unreachable or failing. Check `/health` on the deployed Worker and the Wrangler logs (`bun run webhook:dev` locally, `wrangler tail` for the deployed Worker).
- `Junction webhook receiver returned <status>` from `webhook:register` — the receiver health check failed; the Worker is not reachable at `MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL`.