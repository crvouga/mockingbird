# @crvouga/mockingbird-service-firstpromoter

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful emulator of the **FirstPromoter v2** affiliate API for test suites: promoter create (adopt
before create by `cust_id`), lookups by id / `cust_id` / `ref_token` / email, list, update,
archive, the dashboard iframe login, signup tracking by click `tid`, `promoter_id` or ref token,
campaigns and rewards, and the Basic-auth `lead_becomes_referral` webhook our backend receives.
The legacy **v1** promoters, signup-tracking and campaigns-report routes run over the same store
(best guesses from the vendor docs, not oracle-verified). Every request is
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

Point `FIRST_PROMOTER_API_URL` at the emulator (our Joi schema requires `https`, so either front it
with TLS or relax that rule in the stack), set any `FIRST_PROMOTER_API_KEY` and
`FIRST_PROMOTER_ACCOUNT_ID`, and pass the webhook Basic-auth pair as `--webhook-secret`.

```bash
npx mockingbird-firstpromoter serve --port 8812 \
  --webhook-url http://127.0.0.1:3000/users/webhooks/first-promoter \
  --webhook-secret "$FIRST_PROMOTER_WEBHOOK_AUTH_USERNAME:$FIRST_PROMOTER_WEBHOOK_AUTH_PASSWORD"
```

```ts
import { createServer } from "@crvouga/mockingbird-service-firstpromoter/server"

// Test setup: the emulator, an existing affiliate, and a click on their link.
const server = await createServer({
  webhooks: { url: "http://127.0.0.1:3000/users/webhooks/first-promoter", secret: "user:pass" },
})
const admin = (path: string, body: unknown) =>
  fetch(`${server.url}/__admin${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
await admin("/promoters", { email: "nate@example.com", ref_token: "nate91" })
// The tid checkout stores as fp_tid.
const { tid } = (await (await admin("/clicks", { ref_token: "nate91" })).json()) as { tid: string }

// Application code: FIRST_PROMOTER_API_URL is server.url. The invoice handler tracks the signup.
const baseUrl = server.url
const tracked = await fetch(`${baseUrl}/v2/track/signup`, {
  method: "POST",
  headers: {
    authorization: "Bearer fp-api-key",
    "Account-ID": "acct_1",
    "content-type": "application/json",
  },
  body: JSON.stringify({ email: "customer@example.com", tid }),
})
// The emulator converts the referral and posts lead_becomes_referral to the backend with
// Authorization: Basic…
await server.close()
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /v2/company/promoters` | `{email, cust_id?, profile?: {first_name, last_name}, drip_emails?, initial_campaign_id?}` → the promoter (`FirstPromoterV2ResponseSchema`), enrolled in the default campaign with a `ref_token` (first name + digits) and `ref_link` `https://acme.example/referrals?fpr=<token>`. A live promoter with the same email or `cust_id` is 422 `{message, errors: {email: ["has already been taken"]}}`. |
| `GET /v2/company/promoters?page=&per_page=` | `{data: [promoter], meta: {pending_count}}`; archived promoters are left out. |
| `GET /v2/company/promoters/{value}?find_by=id\|cust_id\|auth_token\|ref_token\|promo_code\|email` | One promoter (archived ones too, with `archived_at`), or 404 `{message: "Promoter not found"}`. `promo_code` resolves codes seeded through `POST /__admin/promo-codes` to the promoter owning that campaign enrolment. `auth_token` is a deterministic per-promoter token that `POST` / `GET /__admin/promoters` report as `auth_token` (the vendor's promoter schema has no such field, so the promoter body does not carry it). Any other `find_by` is 400. |
| `PUT /v2/company/promoters/{id}` | `{cust_id?, email?, note?, profile?}` → the promoter; 404 / 422 as above. |
| `POST /v2/company/promoters/archive` | `{ids: [..]}` → a completed batch `{id, status, total, selected_total, processed_count, failed_count, action_label, progress, processing_errors, …}`. |
| `POST /v2/promoters/iframe_login?promoter_id=` | `{access_token, expires_in}`, or 404. |
| `POST /v2/track/signup` | `{email, tid? \| promoter_id? \| ref_id?, uid?, skip_email_notification?}` → the referral. An unknown `tid`, promoter or ref token is 404; none of them is 400; an email already tracked is 422. With `autoConvert` (default on) the referral becomes a customer at once and `lead_becomes_referral` is posted. |
| `PUT /v2/company/commissions/{id}` | `{internal_note?, external_note?}` (the vendor's `CommissionUpdate`) → the updated commission, reflected in `GET /v2/company/commissions`; other fields are not writable. An unknown id is 404 `{message: "Commission not found", code: "not_found"}`. |
| `GET /v2/company/referrals` | A bare array of stored referrals and live promoter/campaign metadata. `q` searches email/uid; `ids[]`, `filters[type]=lead\|customer`, `filters[state]`, `filters[promoter_id]`, and inclusive `filters[created_at\|customer_since][from\|to]` filter before paging. `page` starts at 1; `per_page` defaults to 20 (max 100). Exhausted pages and unmatched searches return `[]`. |
| `GET /v2/company/referrals/{id}` | The same referral projection as listing. A numeric ID or `find_by=email\|uid` selects it; missing records are 404. |
| `GET /v2/company/campaigns` | **Best guess, not oracle-verified.** A bare array of the configured campaigns (`PUT /__admin/settings` `campaigns`): `{id, name, color, stats: {referrals_count, sales_count, customers_count, promoters_count, revenue_amount}, landing_url, visitor_cookie_life, ref_token_param, auto_approve_leads, track_ad_traffic, auto_approve_promoters, is_private, is_default, upgrade_details, signup_url, links, rewards_for_promoters, rewards_for_referrals}`. `stats` come from stored live promoters, referrals and sales; `is_default` marks `defaultCampaignId`; `landing_url` is the settings `website`. Account settings the emulator has no state for are fixed: `visitor_cookie_life: 60`, `ref_token_param: "fpr"`, auto-approval on, `track_ad_traffic: "allow"`, not private, `upgrade_details` / `signup_url` null, no `links`. `page` / `per_page` (default 10, max 50) follow the v2 API introduction. |
| `GET /v2/company/rewards?scope=promoters\|referrals` | **Best guess, not oracle-verified.** A bare array of every campaign reward, by `id`: `{id, name, is_promoter_reward, promoter_reward_type, coupon, editable, hide_reward, provider_coupon_id, duration, duration_in_months, max_redemptions, new_customers_only, created_at, updated_at, provider, tier_reward_mode, tier_level, schemas: [{unit, amount, flat_amount, rules: []}]}`. `scope=promoters` keeps promoter rewards (`promoterRewards`), `scope=referrals` referred-customer rewards (`referralRewards`); any other scope is 422 `{message, code: "invalid_params"}`. A percent reward is `{unit: "cash", amount: <percent>, flat_amount: false}`. Seeded rewards carry a fixed `created_at` of `2024-01-01T00:00:00.000Z`. |

The [official referral reference](https://docs.firstpromoter.com/api-reference-v2/api-admin/referrals/get-referrals)
specifies the bare array. Paging parameters and limits follow the official
[n8n client](https://github.com/firstpromoter/n8n-app/blob/0842d761a3c024e7cf3030e5a108447375f03807/nodes/FirstPromoter/GeneralFunctions.ts)
and [input definitions](https://github.com/firstpromoter/n8n-app/blob/0842d761a3c024e7cf3030e5a108447375f03807/nodes/FirstPromoter/FirstPromoter.node.ts).

Every v2 call needs `Authorization: Bearer <key>` and an `Account-ID` header (else 401).

The campaign and reward shapes come from the vendor's published v2 OpenAPI
([campaigns](https://docs.firstpromoter.com/api-reference-v2/api-advanced/campaigns-api/openapi-v2-campaigns.json),
[rewards](https://docs.firstpromoter.com/api-reference-v2/api-advanced/rewards/openapi-v2-rewards.json));
no FirstPromoter credentials were available to compare them with a live account.

### Legacy v1 API (best guess, not oracle-verified)

The v1 routes share the v2 store (a promoter created through one API is visible through the
other). They authenticate with `X-API-KEY` only (no `Account-ID`); a missing key is 401 with the
documented JSON string body `"Bad credentials"`, and a v2 Bearer token alone is not accepted. As
documented, parameters travel in the query string; a form or JSON body is read too. Shapes and
messages follow the vendor's v1 reference
([promoters](https://docs.firstpromoter.com/api-reference-v1/promoters-api/openapi-promoters.json),
[signup tracking](https://docs.firstpromoter.com/api-reference-v1/tracking-api/leads-and-signups.md),
[campaigns report](https://docs.firstpromoter.com/api-reference-v1/reports-api/campaign.md));
none of it is oracle-verified. Documented options the emulator has no state for are an
**emulator limitation**: 501 `{message: "Mockingbird: …", code: "mockingbird_unsupported"}`,
checked before anything is stored.

| Route | Behaviour |
| --- | --- |
| `GET /v1/promoters/list?campaign_id=` | Live (unarchived) promoters as v1 promoter objects `{id, status, cust_id, email, created_at, default_promotion_id, default_ref_id, note, auth_token, earnings_balance: {cash}, current_balance, paid_balance, profile, promotions: [{id, campaign_id, ref_id, referral_link, campaign_name, current_offer, current_referral_reward, visitors_count, leads_count, customers_count, sales_count, sales_total, …}], promo_codes: []}`; `status` is `approved` (or `pending`). An unknown `campaign_id` is 422 `{"error": "Campaign not found."}`. No pagination headers. |
| `GET /v1/promoters/show` | By `id`, `promoter_email`, `cust_id`, `ref_id` or `auth_token` (first given wins). 404 `{"error": "Promoter not found."}`; none given is 422. |
| `POST /v1/promoters/create` | `email` (422 `{"error": "Email can't be blank"}` / `"Email is invalid"`), `first_name`, `last_name`, `cust_id`, `ref_id` (the ref token), `campaign_id` (default campaign otherwise; unknown is 422 `Campaign not found.`), `note`, `skip_email_notification` (the emulator sends no email anyway). A live duplicate email / `cust_id` / `ref_id` is 422 `{"error": "Email\|Cust\|Ref has already been taken"}`. `promo_code`, `customer_promo_code`, `temp_password`, `parent_promoter_*`, `created_at`, `always_approve` and the profile/social fields are 501. |
| `PUT /v1/promoters/update` | Finds the promoter by `id`, `cust_id`, `auth_token` or `ref_id`, else by `email`; writes `email` (when it is not the identifier), `first_name`, `last_name`, `new_cust_id`, `new_ref_id` (the default promotion's ref token) and `note`, with the same 422 duplicate checks. `campaign_id`, `promo_code` and the profile/social fields are 501. |
| `DELETE /v1/promoters/delete` | By `id`, `cust_id`, `ref_id` or `auth_token` → `{"message": "Promoter removed."}`. The emulator archives the promoter (v2 lookups still return it with `archived_at`; v1 show/list no longer do); unknown is 404, none given is 422. |
| `POST /v1/track/signup` | `email` (+ optional `uid`) attributed by a click `tid` or a `ref_id` → `{id, type: "signup", amount_cents: null, reward: null, lead: {id, state, email, uid, customer_since, …}, promoter: {…}}`. The lead is the same referral v2 lists, and `autoConvert` applies as for v2. Neither `email` nor `uid`: 400 `{"message": "Error. Email and uid can not be blank!"}`; unknown `tid` / `ref_id`: the documented 404 visitor message; an archived promoter: 404 `This promotion is blocked…`; an email or `uid` already tracked: 422 `{"transaction_id": "there is already a signup event registered on this lead"}`. `uid` without `email`, and `promoter_email`, `created_at`, `username`, `first_name`, `last_name`, `website`, `custom_fields`, `sub_id`, `override_existing_lead`, are 501. `ip` is accepted (the emulator has no fraud analysis). |
| `GET /v1/reports/campaigns` | One row per configured campaign: `{campaign_name, campaign_id, <fields>, items: [{period, <fields>}]}` between `start_date` and `end_date` (`YYYY-MM-DD`, default 12 months ago to today), `group_by=day\|month\|year` (default month; labels `2026-10-04`, `Oct 2026`, `2026`; every period in range is listed). Fields: `selected_fields[]` of `revenue_amount` (sales, as `"$613.17"`), `clicks_count`, `referrals_count` (leads by creation), `customers_count` (by `customer_since`), `sales_count`; default the first four. An unknown field, grouping or date, or day grouping over 90 days, is 422 `{message, code: "invalid_params"}`; the other documented fields (`monthly_churn`, `net_revenue_amount`, the EPC / conversion-rate fields, …) are 501. |
| `POST /v1/promoters/iframe_login` | **Unsupported (emulator limitation).** The vendor's v1 reference documents no `iframe_login` (only v2 does), so there is no defensible behavior to model: 501 `{message: "Mockingbird: V1IframeLogin is not implemented", code: "mockingbird_unsupported"}`, with no token and no state change. Use `POST /v2/promoters/iframe_login`. |

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
| `POST /__admin/commissions` | Seed a commission against an existing `{promoter_campaign_id, amount, unit?, status?, fulfilled?, is_paid?, referral_id?, sale_amount?, event_id?}`. Defaults: approved, points, unfulfilled/unpaid. A referral must belong to that promoter and campaign. |
| `POST /__admin/promo-codes` | Seed `{promo_code, promoter_campaign_id}` against an existing promoter campaign for sale attribution tests. |
| `GET\|PUT /__admin/settings` | `{website?, defaultCampaignId?, autoConvert?, promoCodeCreatesReferral?, campaigns?}` (campaigns carry `referralRewards` / `promoterRewards` with `coupon`, `amount`, `unit`, `per_of_sale`). The default campaign's referral coupon is `ACME50`. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):
`created_but_500` (stored, then 500: the retry must adopt by `cust_id`), `lookup_unavailable`
(lookups 503: neither create nor adopt), `no_campaign` (no `promoter_campaigns`: no ref link),
`unauthorized`, `rate_limited`, `server_error`, `connection_drop`, `webhook_duplicate`,
`webhook_drop`.

Commission reconciliation follows FirstPromoter's [published contract](https://github.com/firstpromoter/docs/blob/d4e9e6f16bf4801c524508d2809a425ea6419d7d/api-reference-v2/api-admin/commissions/openapi-v2-commissions.json):
`GET /v2/company/commissions` returns a bare array, newest first, with `q`, repeated `ids[]`,
`page` / `per_page` (1 / 20 by default, maximum 100), and filters for `status`, nonmonetary
`fulfilled=yes|no`, monetary `paid=yes|no`, `promoter_id`, `campaign_id`, amount / sale-amount
ranges and creation-date ranges. `POST …/commissions/mark_fulfilled` fulfills nonmonetary
commissions; `DELETE …/commissions/destroy` deletes selected commissions. Both take `{ids}`.
Batches of at most five IDs return 200/completed; larger batches return 202/pending. In the
emulator they move to in_progress after the clock advances and complete at 1,000 ms, on the next
authenticated API call. The batch collections and pending work participate in reset and snapshots.
`GET …/batch_processes` and `…/batch_processes/progress` list unfinished work by default
(`filters[status]` selects another status); `GET …/batch_processes/{id}` returns counts and
processing errors. `batch_partial_failure` fails the first selected item while processing the
others. Timing, missing-ID/monetary-item error text, and this preset are synthetic controls;
they are not claims about the vendor's worker timing or exact error messages. Fulfillment is
stored separately from the vendor's `is_paid` monetary field.

`POST /v2/track/sale` follows the vendor's [sale contract](https://github.com/firstpromoter/docs/blob/d4e9e6f16bf4801c524508d2809a425ea6419d7d/api-reference-v2/api-admin/tracking-api/openapi-v2-tracking.json):
`{event_id, amount, email|uid, currency?, plan?, promo_code?, ref_id?, tid?, skip_email_notification?}`
records a positive integer amount in minor units against a tracked referral. The first configured
campaign reward supplies an approved commission; percent rewards are rounded to the nearest
minor unit, and flat rewards use their configured amount. Cash rewards also credit the existing
promoter balance; nonmonetary rewards do not. The response includes the referral, amount and
linked commissions, visible in the commission collection. Replaying an event ID returns the
documented 409 without another credit, commission or webhook. Unknown referrals, archived
promoters and unmatched supplied attribution tokens return the documented 404 `not_found` shape.
Codes must be seeded through the admin control; tokens must belong to the referral's promoter
campaign. All validation precedes sale/commission/balance writes; snapshots/reset include event
deduplication. A successful sale preserves the existing conversion webhook behavior.

When no lead matches `email` / `uid`, the vendor's [tracking contract](https://github.com/firstpromoter/docs/blob/d4e9e6f16bf4801c524508d2809a425ea6419d7d/api-reference-v2/api-admin/tracking-api/openapi-v2-tracking.json)
lets `tid` or `ref_id` "bypass the signup tracking": the lead is created and the sale assigned in
one request. The emulator does the same when the `tid` (a click from `POST /__admin/clicks`) or
`ref_id` resolves to a live promoter and the request names the lead by `email`; the new lead counts
toward the promoter's referrals, becomes a customer and posts `lead_becomes_referral`. This is
docs-verified (the tracking OpenAPI above), not oracle-verified. `uid` alone cannot name a new lead,
and an `email` that is already a lead under another `uid` is 422 (as in signup tracking).

**`promo_code` alone: best guess, not oracle-verified.** The vendor documents nothing further for
`promo_code` ("For promo code tracking"), so whether a sale carrying only a promo code creates the
lead is unobserved. Default (`promoCodeCreatesReferral: false`): a sale for an unknown buyer with
only `promo_code` is the same 404 as any unattributed sale, and nothing is stored. Opt in with
`PUT /__admin/settings {"promoCodeCreatesReferral": true}` to have a code seeded through
`POST /__admin/promo-codes` create the lead (needs `email`), assign the sale to the promoter owning
that campaign enrolment, and post `lead_becomes_referral`, exactly like `tid` / `ref_id`. An
unseeded code is 404 in both modes. Treat a test that depends on this setting as depending on an
emulator assumption until a live response is captured.

### Namespaces

`x-mockingbird-namespace`, a `/__admin/ns/<name>` prefix in `FIRST_PROMOTER_API_URL`, or by API key:
`PUT /__admin/credentials {"credentials": {"<FIRST_PROMOTER_API_KEY>": "<namespace>"}}`. The key is the v2
Bearer token or, for v1 calls, the `X-API-KEY` value.

### Deliberately not modelled

- Error bodies and exact status codes of the real API are unverified (no sandbox credentials):
  errors use `{message}` and validation `{message, errors: {field: [...]}}`. Our consumer only
  branches on `ok` / 404, which the emulator gets right.
- v1 `iframe_login` (undocumented by the vendor, answered 501), the other v1 APIs (leads,
  sales/refund/cancellation tracking, rewards, payouts, promoter and overview reports,
  `move_to_campaign`, `add_to_campaign`, `refresh_token`), v1 pagination headers, and the v1
  options listed above as 501.
- Refunds, standalone commission creation/editing/approval, cash payouts and commission filters
  beyond those listed above; fraud checks;
  public promo-code provisioning; the hosted affiliate portal behind the iframe token.
- Creating a lead from `promo_code` alone is off by default (`promoCodeCreatesReferral`): the vendor documents the one-step bypass only for `tid` and `ref_id`, so the opt-in behavior is a best guess, not oracle-verified.
- Currency is recorded without foreign-exchange conversion; plan-specific rewards, quantity/MRR
  calculations, multiple reward tiers, split commissions and notification emails are unmodelled.
  Commission rounding and immediate approval are deterministic emulator policies, not live-verified
  campaign policy. The default campaign reward remains 10 percent, as before.
- Referral editing/deletion, username/website profile provisioning, cancelled-date filters and split attribution.
- Promoter ids are sequential from 4800001 per namespace.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `FirstPromoterAPI` | class | The in-process emulator: `fetch(request)`, `reset()`, `render(promoter)`, `click(refToken)`, `convert(referralId, saleAmount?)`, `seedPromoter(input)`, `state`. Options: `sqlite`, `now`, `namespace`, `settings`, `onWebhook`. |
| `createRuntime` | function | The emulator with the full service contract (health, admin, namespaces, credentials, presets, webhooks). Options: `webhooks: {url, secret, retryDelaysMs?, fetch?}`, `settings`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `FIRSTPROMOTER_PRESETS` | object | Every named fault preset. |
| `FIRSTPROMOTER_NAMESPACE` | string | The service name, `"firstpromoter"`. |
| `WEBHOOK_PATH` | string | Our receiver's path, `/users/webhooks/first-promoter`. |
| `DEFAULT_CAMPAIGNS`, `DEFAULT_SETTINGS` | values | The seeded campaigns and settings. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8812. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
