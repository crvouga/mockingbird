# Consumer wiring: point a Stripe client at the mock

Everything below happens in the consumer's repository. The mock side is complete; these are the
steps that make a suite actually talk to it.

This checklist is deliberately project-neutral: it lists what any consumer must do, not where in
any particular codebase the change goes.

## 1. Give every Stripe client a base-URL override

stripe-node accepts `{host, port, protocol}`. Add one env read (e.g.
`STRIPE_API_BASE_URL=http://127.0.0.1:12111`) at every client construction site, so the same
processes can be pointed at the mock without code edits:

```ts
const base = process.env.STRIPE_API_BASE_URL
const client = new Stripe(apiKey, {
  apiVersion: "2024-06-20",
  ...(base === undefined ? {} : parseBaseUrl(base)),
})
```

Apply it to every constructor — production adapters, catalog/coupon services, dev-tools clients,
e2e helpers and any direct SDK use in test code. A client built with `new Stripe(key)` and no
options cannot be redirected.

## 2. Keep the credential shapes

No validation change is needed: test-mode keys stay `sk_test_*` / `rk_test_*` and webhook secrets
stay `whsec_*`, which is what this mock accepts and what consumer-side validators typically
already require. The mock only rejects keys that do not look like test-mode keys.

## 3. Deliver webhooks from the mock instead of the Stripe CLI

Run the mock server and point its webhook targets at the consumer's intake routes:

```bash
PORT=12111 \
MOCKINGBIRD_STRIPE_WEBHOOK_TARGETS='[
  {"apiKey":"<primary test key>","url":"http://127.0.0.1:<app port>/<primary webhook path>","secret":"<primary webhook secret>"},
  {"apiKey":"<secondary test key>","url":"http://127.0.0.1:<app port>/<secondary webhook path>","secret":"<secondary webhook secret>"}
]' \
bun run mock:server
```

Events are matched to a target by the API key that produced them. Without a matching target the
event is still recorded (and readable through `GET /v1/events`), so a replay sweep keeps working.
`MOCKINGBIRD_STRIPE_WEBHOOK_URL` + `MOCKINGBIRD_STRIPE_WEBHOOK_SECRET` configure a single fallback
target. Any existing env fan-out that distributes one CLI `whsec_` across several webhook-secret
variables keeps working — point it at the mock's target secret instead.

## 4. Use two different mock keys for two accounts

The mock partitions state per bearer key. A consumer that asserts account isolation must give each
account its own key, otherwise objects created for one account are visible to the other.

## 5. Acceptance

- The end-to-end suites run with no egress to `api.stripe.com`.
- Webhooks arrive without the Stripe CLI installed.
- Browser-driven checkout scenarios keep using real Stripe test mode (the mock serves REST and
  webhooks only).
