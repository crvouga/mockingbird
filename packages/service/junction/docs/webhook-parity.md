# Junction webhook parity receiver

Junction live parity requires a reachable webhook receiver. The receiver is a Cloudflare Worker with a stable `workers.dev` URL and a Durable Object that keeps events isolated by parity run ID.

## Configuration

Required environment variables:

- `MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL` — deployed Worker base URL, for example `https://mockingbird-junction-webhooks.<account>.workers.dev`.
- `MOCKINGBIRD_JUNCTION_MANAGEMENT_KEY` — Junction Management API key (`mg_*`), loaded from Vault.
- `MOCKINGBIRD_JUNCTION_ORG_ID` — Junction organization UUID.
- `MOCKINGBIRD_JUNCTION_TEAM_ID` — Junction sandbox team UUID.
- Cloudflare Wrangler credentials (`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`) for CI deployment.

The Management API key is separate from the Junction sandbox Team API key. It is sent in `X-Management-Key` only.

## Local setup

From `packages/service/junction`:

```sh
bun run webhook:dev
```

For live Junction delivery, the local receiver must be reachable from the public internet. Use the stable deployed `workers.dev` receiver for parity, or provide a temporary public proxy and set `MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL` to that URL.

## Deploy and register

```sh
bun run webhook:deploy
export MOCKINGBIRD_JUNCTION_WEBHOOK_URL="$MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL/junction/webhooks"
bun run webhook:register
```

Registration reconciles the sandbox webhook at:

```text
https://api.management.junction.com/v1/org/{org_id}/team/{team_id}/sandbox/webhook
```

The registration command is idempotent. It lists existing endpoints, reuses the matching URL when configured correctly, and fails instead of silently accepting a disabled or incorrectly filtered endpoint. It prints the exact endpoint URL and Junction webhook ID.

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
MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL="$MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL" bun run parity:junction
```

If the receiver URL is missing, parity fails immediately instead of treating zero events as a valid webhook parity result.
