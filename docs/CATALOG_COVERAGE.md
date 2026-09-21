# Service catalog coverage

Where each section of the geviti "Mockingbird wish list — service catalog" (2026-09-20) lives in
this repo, how it is proven, and what the proof turned up. Every package follows
[AUTHORING_A_SERVICE.md](AUTHORING_A_SERVICE.md) and ships the same evidence:

- **Self-parity**: two independent instances run random OpenAPI-driven walks and must agree after
  every command, with every response conforming to the package's contract; each suite asserts
  the walks reach every parity-enabled operation and that a deliberately divergent instance is
  caught.
- **Acceptance**: every acceptance bullet of the catalog section, driven through
  `test/consumer.ts`, a port of the consumer's own client and webhook-receiver code.
- **SDK drop-in**: the vendor's official SDK, at the version the consumer pins, pointed at the
  mock (where the consumer uses one).
- **Live parity** (`bun run parity:service -- <name>`): the same walks against the real sandbox,
  when credentials exist in Vault `secret/personal/prd`.

| § | Vendor | Package | SDK drop-in | Live parity |
| --- | --- | --- | --- | --- |
| S1 | Stripe | `service-stripe` | stripe-node 16.12 (2024-06-20, 2025-02-24.acacia), 17.7 | **passing** on well-formed walks (`parity -- --valid-only`) |
| S2 | Gene by Gene | `service-genebygene` | — (raw fetch) | no credentials |
| S3 | RxVortex (Strive) | `service-rxvortex` | — (raw fetch) | no credentials |
| S4 | Flex | `service-flex` | svix 1.41 (webhook verification) | no credentials |
| S5 | Mail inbox | `service-mailosaur` | mailosaur 11.1 | no credentials |
| S6 | PostHog | `service-posthog` | posthog-node 5.52, @posthog/core 1.54, posthog-js 1.433 (transport) | no credentials |
| S7 | AWS Bedrock Runtime | `service-bedrock` | @aws-sdk/client-bedrock-runtime, AgentCore, @ai-sdk/amazon-bedrock + ai | no credentials |
| S8 | Twilio | `service-twilio` | twilio 5.10 | **passing** (Lookup v2, free operations only) |
| S9 | Resend | `service-resend` | resend 4.8, svix 1.41 | no credentials |
| S10 | AHA | `service-aha` | — (raw fetch) | no credentials |
| S11 | Daily.co | `service-daily` | — (raw fetch) | no credentials |
| S12 | Pharmetika, VPI, Wholescripts, portal agent | `service-pharmetika`, `-vpi`, `-wholescripts`, `-portal-agent` | — | no credentials |
| S13 | AWS Polly + Transcribe | `service-aws-speech` | @aws-sdk/client-polly, -transcribe-streaming, -transcribe | no credentials |
| S14 | LlamaCloud | `service-llamacloud` | llama-cloud-services 0.6.88 (Python, opt-in) | no credentials |
| S15 | Legacy Makor AI (CPG) | `service-makor-cpg` | — | no credentials |
| S16 | Intercom | `service-intercom` | — (raw fetch) | no credentials |
| S17 | Slack | `service-slack` | @slack/web-api 7.9 | no credentials |
| S18 | OTLP + OpenObserve | `service-otel` | OpenTelemetry exporters 0.201 (HTTP JSON and protobuf) | no credentials |
| S19 | Customer.io, Klaviyo, First Promoter | `service-customerio`, `-klaviyo`, `-firstpromoter` | @customerio/cdp-analytics-node 0.5.6 | no credentials |
| S20 | Formbricks | `service-formbricks` | — | no credentials |
| S21 | Google Places / Maps / Geocode | `service-google-maps` | Maps JS shim evaluated in a fake window | no credentials |
| S22 | Persona | `service-persona` | — | no credentials |
| S23 | Healthie | `service-healthie` | graphql-request 7.2, awesome-graphql-client 0.14 (the consumer's clients) | no credentials |
| S24 | Optimal DX | `service-odx` | — | no credentials |
| S25 | EasyPost, Fullscript, Google Calendar, Plane, Payload CMS, CareTalk, Edamam, Prism | `service-easypost`, `-fullscript`, `-google-calendar`, `-plane`, `-payload-cms`, `-caretalk`, `-edamam`, `-prism` | @googleapis/calendar 9.8 | no credentials |

"No credentials" means the package's `scripts/parity.ts` exits 2 and names the
`MOCKINGBIRD_<VENDOR>_*` keys it needs; add them to Vault and `bun run parity:service -- <name>`
runs the live walk. The Junction mock (catalog: "already exists") is unchanged.

## What live parity fixed in the Stripe mock

Walks against Stripe test mode, each confirmed with a targeted probe before changing the mock:

- ids in `No such …` errors are escaped Ruby-style (`<` → `<`, `'` → `\'`), get a
  whitespace/quotes hint, and are elided past 998 characters;
- `starting_after` is resolved before "both cursors" and before the path's customer;
  `customer` + `customer_account` and `scheduled` + `*_at` filters are mutually exclusive;
  an unknown `test_clock` filter is `No such billingclock`; the customer balance-transaction
  cursor is an `abstracttransaction`;
- `package_dimensions`: order length, width, height, weight; plain decimals only; at most 15
  fraction digits, then at most two decimal places, echoed as a Ruby Float (`1.0e-07`);
- `marketing_features[].name` is capped at 80 characters (docs say 5000) and trimmed;
  `address.country` is upper-cased; `metadata` given as a scalar gets Stripe's own message;
- search: `total_count` only with `expand[]=total_count` (lists refuse it with "cannot be
  included"); an invalid page names the token as `param`, elided past 1000 characters;
- a request line over 16 KiB is nginx's HTML 414;
- a declined PaymentIntent omits (never nulls) `advice_code` / `decline_code` /
  `network_decline_code` in `last_payment_error` (found by self-parity conformance).

Malformed-request walks (the default `parity` mode) still diverge on Stripe's per-endpoint
validation order for requests carrying several invalid parameters at once; `--valid-only`
compares behaviour on well-formed requests, which is what the consumer sends.

## Consumer bugs and catalog discrepancies the mocks surfaced

Each is pinned in a test comment in the named package.

- **Bedrock**: chat retries never fire (AI SDK v6 emits `start` before an error part);
  `BedrockLlmProvider`'s stream-error branches are unreachable (the AWS SDK throws exception
  frames); the catalog's `report_rx_symptom` input shape is wrong.
- **AHA**: `AhaService` never checks the inner `status`; the lab-provider cancel sends the
  AHA `order_number` as `partner_order_id` (G-A1); "Non Scheduled Update" is not ignored.
- **Daily**: the EMR patient token's `exp` is in milliseconds; backend rooms' `nbf` blocks the
  5-minute early join the member token allows.
- **Persona**: every outcome passes through `completed`, so a later-declined member was
  already marked verified; a wrong-length signature is a 500.
- **Google Maps**: native autocomplete counts `ZERO_RESULTS` as success, so manual entry never
  engages for unknown addresses.
- **Healthie**: `createLocation` sends line 2 as the city; an undeclared `timezone` variable is
  ignored; the forms receiver reads a field its query never selects.
- **Optimal DX**: `updateWebhook` sends method `'Put'`, which becomes a GET; stale
  registrations accumulate.
- **Mailosaur**: the SDK always connects to port 443, so G-M1 needs `HTTPS_PROXY` +
  `NODE_EXTRA_CA_CERTS` (the mock serves TLS with `--tls-port`), not only a base URL.
- **Pharmetika**: a refused cancel reports "[object Object]"; the portal-agent callback
  receiver rejects `pharmacyId: "pharmetika"`. **VPI** has no delivered state and polls only
  page 1 of 5; **Wholescripts** maps "Complete" to shipped.
- **RxVortex**: an empty `errors: []` yields `invalid fields=`, not the plain message.
- **LlamaCloud**: Makor's default project `"default"` ≠ the backend's `"Default"`.
- **Twilio**: the dispatcher treats every provider status ≥ 400 (5xx included) as definite.
- **Customer.io** under Bun reports `ConnectionRefused` where the code expects
  `ECONNREFUSED`; **First Promoter** is never called outside production and requires an https
  URL; **Klaviyo** is sent a user token as the profile id.
- **OTel**: the EMR pino bridge sends lowercase severity while recipes filter `'ERROR'`.
- **Flex, Stripe, Slack, Formbricks**: several fixtures and files the catalog cites exist only on
  the `crvouga/makor-voice-chat` branch or in history (e.g. `flexCatalogMappings.json` has 663
  rows, not 67).
