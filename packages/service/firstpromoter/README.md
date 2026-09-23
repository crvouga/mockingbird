# @crvouga/mockingbird-service-firstpromoter

Stateful mock of the **FirstPromoter v2** affiliate API for test suites: promoter create (adopt
before create by `cust_id`), lookups by id / `cust_id` / `ref_token` / email, list, update,
archive, the dashboard iframe login, signup tracking by click `tid`, `promoter_id` or ref token,
and the Basic-auth `lead_becomes_referral` webhook our backend receives. Every request is
recorded in the journal, so a checkout suite can assert what the post-checkout job sent instead
of producing a failed job.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/firstpromoter/SUPPORT.md)
- FirstPromoter publishes no machine-readable spec: the contract (`openapi.yaml`) is
  hand-authored from our consumer's requests and the zod schemas it validates responses with.

## Install

```bash
npm install -D @crvouga/mockingbird-service-firstpromoter
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-firstpromoter serve`, `createServer` from `./server` (Node), or `createRuntime`
with any Fetch server.

## Usage

Point `FIRST_PROMOTER_API_URL` at the mock (our Joi schema requires `https`, so either front it
with TLS or relax that rule in the stack), set any `FIRST_PROMOTER_API_KEY` and
`FIRST_PROMOTER_ACCOUNT_ID`, and pass the webhook Basic-auth pair as `--webhook-secret`.

```bash
npx mockingbird-firstpromoter serve --port 8812 \
  --webhook-url http://127.0.0.1:3000/users/webhooks/first-promoter \
  --webhook-secret "$FIRST_PROMOTER_WEBHOOK_AUTH_USERNAME:$FIRST_PROMOTER_WEBHOOK_AUTH_PASSWORD"
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-firstpromoter"

const fp = createRuntime({
  webhooks: { url: "http://127.0.0.1:3000/users/webhooks/first-promoter", secret: "user:pass" },
})
const admin = (path: string, body: unknown) =>
  fp.fetch(
    new Request(`http://fp.test/__admin${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )

// An existing affiliate, and a click on their link: the tid checkout stores as fp_tid.
await admin("/promoters", { email: "nate@example.com", ref_token: "nate91" })
const { tid } = (await (await admin("/clicks", { ref_token: "nate91" })).json()) as { tid: string }
// …the app's invoice handler posts POST /v2/track/signup {email, tid}; the mock converts the
// referral and posts lead_becomes_referral to the backend with Authorization: Basic…
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /v2/company/promoters` | `{email, cust_id?, profile?: {first_name, last_name}, drip_emails?, initial_campaign_id?}` → the promoter (`FirstPromoterV2ResponseSchema`), enrolled in the default campaign with a `ref_token` (first name + digits) and `ref_link` `https://gogeviti.com/referrals?fpr=<token>`. A live promoter with the same email or `cust_id` is 422 `{message, errors: {email: ["has already been taken"]}}`. |
| `GET /v2/company/promoters?page=&per_page=` | `{data: [promoter], meta: {pending_count}}`; archived promoters are left out. |
| `GET /v2/company/promoters/{value}?find_by=id\|cust_id\|ref_token\|email` | One promoter (archived ones too, with `archived_at`), or 404 `{message: "Promoter not found"}`. |
| `PUT /v2/company/promoters/{id}` | `{cust_id?, email?, note?, profile?}` → the promoter; 404 / 422 as above. |
| `POST /v2/company/promoters/archive` | `{ids: [..]}` → a completed batch `{id, status, total, selected_total, processed_count, failed_count, action_label, progress, processing_errors, …}`. |
| `POST /v2/promoters/iframe_login?promoter_id=` | `{access_token, expires_in}`, or 404. |
| `POST /v2/track/signup` | `{email, tid? \| promoter_id? \| ref_id?, uid?, skip_email_notification?}` → the referral. An unknown `tid`, promoter or ref token is 404; none of them is 400; an email already tracked is 422. With `autoConvert` (default on) the referral becomes a customer at once and `lead_becomes_referral` is posted. |

Every call needs `Authorization: Bearer <key>` and an `Account-ID` header (else 401).

### Webhooks

`lead_becomes_referral` bodies match our `FirstPromoterNewCustomerWebhookSchema`: `{event: {id,
type, created_at}, data: {id, state, email, customer_since, promotion: {id, promoter_id, ref_id,
leads_count, customers_count, current_referral_reward}, promoter: {id, cust_id, email,
earnings_balance: {cash}}}}`, sent with `Authorization: Basic base64(<secret>)` where the secret
is `user:pass`. Non-2xx answers are retried; `GET /__admin/webhooks`, `…/events`, `…/flush` and
`PUT /__admin/webhook-endpoints` work as usual.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/promoters` | Seed a promoter `{email, cust_id?, first_name?, last_name?, ref_token?, campaign_id?}`. |
| `GET /__admin/promoters` | The namespace's promoters (stored form). |
| `POST /__admin/clicks` | `{ref_token}` → `{tid, promoterId}`: a click on the promoter's link. |
| `GET /__admin/referrals` | Tracked signups. |
| `POST /__admin/referrals/:id/convert` | `{saleAmount?}`: the lead paid; credits the promoter (percent reward × amount) and posts the webhook. |
| `GET\|PUT /__admin/settings` | `{website?, defaultCampaignId?, autoConvert?, campaigns?}` (campaigns carry `referralRewards` / `promoterRewards` with `coupon`, `amount`, `unit`, `per_of_sale`). The default campaign's referral coupon is `GEVITI50`. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):
`created_but_500` (stored, then 500: the retry must adopt by `cust_id`), `lookup_unavailable`
(lookups 503: neither create nor adopt), `no_campaign` (no `promoter_campaigns`: no ref link),
`unauthorized`, `rate_limited`, `server_error`, `connection_drop`, `webhook_duplicate`,
`webhook_drop`.

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix in `FIRST_PROMOTER_API_URL`, or by API key:
`PUT /__admin/credentials {"credentials": {"<FIRST_PROMOTER_API_KEY>": "<namespace>"}}`.

### Deliberately not modelled

- Error bodies and exact status codes of the real API are unverified (no sandbox credentials):
  errors use `{message}` and validation `{message, errors: {field: [...]}}`. Our consumer only
  branches on `ok` / 404, which the mock gets right.
- The v1 API our EMR backend still calls (`/v1/promoters/*`, `/v1/track/signup`,
  `/v1/reports/campaigns`); the catalog scopes this mock to v2.
- Sales, refunds, commissions and payouts beyond the single `convert` step; fraud checks;
  promo codes; the hosted affiliate portal behind the iframe token.
- Promoter ids are sequential from 4800001 per namespace.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `FirstPromoterAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `render(promoter)`, `click(refToken)`, `convert(referralId, saleAmount?)`, `seedPromoter(input)`, `state`. Options: `sqlite`, `now`, `namespace`, `settings`, `onWebhook`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets, webhooks). Options: `webhooks: {url, secret, retryDelaysMs?, fetch?}`, `settings`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `FIRSTPROMOTER_PRESETS` | object | Every named fault preset. |
| `FIRSTPROMOTER_NAMESPACE` | string | The service name, `"firstpromoter"`. |
| `WEBHOOK_PATH` | string | Our receiver's path, `/users/webhooks/first-promoter`. |
| `DEFAULT_CAMPAIGNS`, `DEFAULT_SETTINGS` | values | The seeded campaigns and settings. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8812. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
