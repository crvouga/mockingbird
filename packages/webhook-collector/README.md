# Webhook collector

The Hono app accepts JSON webhooks at `POST /:service` for any lowercase service slug (letters, digits, hyphens). The Astro docs site mounts it at `/webhook`, so `POST /webhook/new-provider` works without changing or redeploying the collector. Removing a service means unregistering its webhook URL with the provider; no collector config lists services.

Each event stores its service, optional `x-mockingbird-scope` or `run_id` query value, timestamp, request headers, and JSON payload. `GET /events?service=...&run_id=...` returns records; `GET /events/:runId?service=...` returns payloads for parity tests. Reads require `Authorization: Bearer <WEBHOOK_READ_TOKEN>`. Webhook POSTs remain unauthenticated so providers can deliver to the endpoint; signature headers are retained for verification by service-specific parity code.

The Astro integration uses Bun SQLite. Set `WEBHOOK_DB` to a path on a persistent volume and `WEBHOOK_READ_TOKEN` in the docs host's environment; neither value belongs in this repository. Parity runs send the same token as `MOCKINGBIRD_WEBHOOK_READ_TOKEN` (a repo secret, or `.env.local`). Without a mounted volume, data is lost when the docs container is replaced. The database schema and Hono API do not enumerate services, so adding a provider only requires registering its URL and teaching that provider's parity test to read its events.
