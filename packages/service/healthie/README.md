# @crvouga/mockingbird-service-healthie

Stateful mock of the **Healthie GraphQL API**, covering the legacy surface our backend still
calls:

- sign-in, users, the current user, and profile, password and avatar updates
- client updates and addresses
- documents and folders, including multipart uploads, with downloads served by the mock
- requested forms and form answers
- offerings and billing items
- the IP-allowlisted status webhooks

GraphQL documents run on the reference [`graphql`](https://www.npmjs.com/package/graphql)
implementation against a subset of Healthie's schema written by hand. Selection sets, aliases,
fragments, variables, `__typename` and validation errors therefore behave as they do on
Healthie, and the mock returns only the fields a document asks for.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/healthie/SUPPORT.md)
- Healthie publishes an SDL but no OpenAPI. `openapi.yaml` describes the HTTP side: one GraphQL
  operation and the file-download route. The GraphQL schema is `HEALTHIE_SDL`.

> **Is this worth testing?** The catalog (S23) marks Healthie as legacy. Appointments and
> providers moved to Medplum. What is left is legacy sign-in, password reset, profile and
> address, the ODX document upload, and admin export and migration. Check that a suite still
> exercises these paths before you wire the mock into the stack. It is fully implemented
> either way.

## Install

```bash
npm install -D @crvouga/mockingbird-service-healthie
```

ESM only. Node >= 22 or Bun >= 1.2. The one runtime dependency besides `hono` is the public
`graphql` package (pinned to 16.11.0, the version our backend uses). See
[Why `graphql`](#why-graphql-is-a-runtime-dependency). Serve it with
`npx mockingbird-healthie serve`, `createServer` from `./server` (Node), or `createRuntime`
with any Fetch server.

## Usage

Point `HEALTHIE_API_URL` at `http://127.0.0.1:8816/graphql`. This needs seam **G-H1** first:
the backend's Joi and zod schemas currently accept only the staging or prod URL, and
`HEALTHIE_WEBHOOK_IP_ADDRESS` only the two IP lists. Set `HEALTHIE_API_AUTH_TOKEN` in the app
and pass the same value as `--api-key`.

```bash
npx mockingbird-healthie serve --port 8816 \
  --api-key "$HEALTHIE_API_AUTH_TOKEN" \
  --webhook-base-url http://127.0.0.1:3000 \
  --webhook-ip 18.206.70.225
```

```ts
import { createRuntime, SEED } from "@crvouga/mockingbird-service-healthie"

const healthie = createRuntime({
  settings: { orgApiKeys: ["gh_sbox_test_org"] },
  webhooks: { baseUrl: "http://127.0.0.1:3000", ip: "18.206.70.225" },
})
const graphql = (query: string, variables: object, key?: string) =>
  healthie.fetch(
    new Request("http://healthie.test/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        AuthorizationSource: "API",
        ...(key ? { authorization: `Basic ${key}` } : {}),
      },
      body: JSON.stringify({ query, variables }),
    }),
  )

// The seeded demo patient signs in and gets an API key, as the member app does.
const signedIn = await graphql(
  `mutation($e: String, $p: String) {
     signIn(input: { email: $e, password: $p, generate_api_token: true }) { api_key user { id active } }
   }`,
  { e: SEED.patientEmail, p: SEED.patientPassword },
)

// Ask Healthie to request a form from the patient; POST /forms/webhooks/status follows.
await healthie.fetch(
  new Request("http://healthie.test/__admin/requested-forms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipient_id: SEED.patientId }),
  }),
)
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /graphql` | One document per request, sent as JSON `{query, variables, operationName}` or as a [GraphQL multipart request](https://github.com/jaydenseric/graphql-multipart-request-spec) (`operations`, `map`, file parts) for `Upload` variables. The `Authorization` header carries the API key as `Bearer <key>`, `Basic <key>` or the bare key. `AuthorizationSource: API` is accepted and ignored. Errors come back with HTTP 200, as on Healthie. A body that is not GraphQL gets a 400. |
| `GET /files/{token}` | The bytes behind `document.expiring_url` and `user.avatar_url`, which point here on the request's own origin (with `/ns/<name>` when namespaced). Links are signed and expire on the mock clock (`expiringUrlSeconds`, default 300). A tampered or expired link gets a 403 and a deleted file a 404. Each download adds one entry to `document.opens`. |

GraphQL root fields: `currentUser`, `user(id)`, `users(keywords, should_paginate, …)`,
`location(id)`, `locations`, `documents(…)`, `document(id)`, `folders(…)`,
`requestedFormCompletion(id)`, `formAnswerGroups(user_id, …)`, `formAnswerGroup(id)`,
`initialFormAnswers(custom_module_form_id, incomplete_form_id, user_id)`,
`offerings(client_visibility, offering_id, …)` and
`billingItems(offerings_only, client_id, status)`.

Mutations:

- `signIn(input)`: `generate_api_token` and `allow_multiple_api_keys` are honoured, and so is
  `namespace` when one is set.
- `updateUser(input)`: sets profile fields, uploads an avatar as an `Upload`, removes it with
  `avatar: null`, or changes the password. The password variant sends no `id` and checks
  `current_password` and `password_confirmation`.
- `updateClient(input)`: `metadata`, `phone_number`, `password`, `other_provider_ids`,
  `user_group_id`, `dietitian_id`, `active`, and `location` as a `ClientLocationInput`.
- `createLocation` and `updateLocation`.
- `createFolder`: parses `share_users` given as `"user-<id>,…"`.
- `createDocument`: takes an `Upload` or a `file_string` data URL, plus `share_users` and
  `rel_user_id`.
- `deleteDocument`.
- `updateBillingItem`: `is_paused`, `is_canceled`, `note` and `state`. Our client sends it as
  two aliased mutations in one document; each emits `billing_item.updated`.

Behaviour our code branches on:

- **Bad key:** an unknown API key returns `errors: [{message: "API Key is Invalid"}]`, which
  our client maps to 401.
- **No key:** `currentUser` is `null`, lists are empty and mutations other than `signIn` fail.
  Our `listFiles` turns the `null` into a 401.
- **Validation:** failures come back as `messages: [{field, message}]` with a `null` payload,
  which our client maps to 400. `messages` is `null` on success; our `getFolderByPath` treats
  any non-null value as failure.
- **Sign-in:** a wrong email or password returns `user: null`, which our client maps to
  `INVALID_SIGN_IN_CREDENTIALS`. An archived user signs in with `active: false`, which maps to
  `USER_ARCHIVED`.
- **Who sees what:** a patient key sees only its own user, its care team, its own files and
  anything shared with it. The organization key sees everything.

### Webhooks

Healthie events are posted as `{resource_id, resource_id_type, event_type, changed_fields?}`.
`resource_id` is sent as a string, because our DTOs validate `@IsString()`. Each request
carries `x-forwarded-for: <ip>`, and that header is our receivers' only check against
`HEALTHIE_WEBHOOK_IP_ADDRESS`. Nothing is signed.

| Event | Receiver (`--webhook-base-url` + path) | Emitted by |
| --- | --- | --- |
| `patient.created`, `patient.updated` | `/users/webhook/status` | `updateUser`, `updateClient`, `POST /__admin/users`, archive and unarchive |
| `requested_form_completion.created`, `form_answer_group.created` | `/forms/webhooks/status` | `POST /__admin/requested-forms`, `POST /__admin/form-answer-groups` |
| `billing_item.updated` | (none by default; add one with `PUT /__admin/webhook-endpoints`) | `updateBillingItem` |

`POST /__admin/events {event_type, resource_id, resource_id_type}` emits any event. Deliveries
are retried immediately, then after 5 s, 5 min, 30 min and 2 h. The standard admin routes
also apply: `GET /__admin/webhooks`, `…/events`, `…/:id/replay` and `…/flush`.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `GET /__admin/users`, `POST /__admin/users` | List users (never passwords). Create one from `{email, password, first_name?, last_name?, role?: patient \| provider, active?, dietitian_id?, …}` and get back `{user, api_key}`. |
| `POST /__admin/users/:id/archive` \| `/unarchive` | Set `active` (archived users sign in with `active: false`). |
| `POST /__admin/users/:id/api-keys` | Issue another API key for a user. |
| `POST /__admin/offerings` | `{name, price?, billing_frequency?, visibility_status?}`. |
| `POST /__admin/billing-items` | `{sender_id, offering_id?, amount_paid?, state?, is_recurring?, next_payment_date?}`. |
| `POST /__admin/form-answer-groups` | `{user_id, custom_module_form_id?, filler_id?, answers?: {<label or module id>: answer}}` (emits the forms webhook). |
| `POST /__admin/requested-forms` | `{recipient_id, sender_id?, custom_module_form_id?}` (emits the forms webhook). |
| `POST /__admin/events` | Emit any Healthie event. |
| `GET /__admin/documents` | Document metadata for the namespace. |
| `GET` \| `PUT /__admin/settings` | `{orgApiKeys?, namespace?: string \| null, expiringUrlSeconds?}`. |

Seed data (`SEED`), recreated on reset:

- `100001`: the organization admin, bound to every `orgApiKeys` entry (default
  `gh_sbox_org_api_key`).
- `100002`: dietitian Dana Rivera, MD.
- `100003`: demo patient `patient@healthie.mock` / `Password123!`.
- Offerings `200001` (membership, visible) and `200002` (add-on, hidden).
- Intake form `300001`.

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`):

- `invalid_api_key`
- `graphql_500`: an error message containing `500`, for our 500 branch.
- `validation_messages`
- `current_user_null`
- `expired_urls`
- `http_500`
- `rate_limited` (429)
- `server_error`
- `webhook_duplicate`, `webhook_reorder`, `webhook_drop`

### Namespaces

Choose a namespace in any of three ways:

- the `x-mockingbird-namespace` header;
- a `/ns/<name>/graphql` prefix on `HEALTHIE_API_URL` (file URLs keep the prefix);
- by API key, with `PUT /__admin/credentials {"credentials": {"<key>": "<namespace>"}}`.

`signIn` sends no key, so parallel suites that sign in need the header or the path prefix.

### Clients

Healthie has no official Node SDK. Our backend talks to it through `graphql-request` 7.2.0
(plain documents) and `awesome-graphql-client` 0.14.1 (multipart `Upload` documents). The
acceptance tests drive the mock through those exact versions, pinned as devDependencies, with
the backend's documents copied verbatim (`test/consumer.ts`). A separate SDK drop-in test would
repeat them.

### Why `graphql` is a runtime dependency

Our consumer's documents need real GraphQL semantics: validation against a schema,
per-selection resolution, aliases (two `updateBillingItem`s in one document), `__typename`,
and variable coercion. That includes graphql-js dropping undeclared variables, which one of
our documents relies on unknowingly.

A hand-rolled parser would drift from those rules, which are exactly what parity has to
preserve. `graphql` is a public, dependency-free npm package, pinned to the version our
backend uses, so it ships as a normal `dependency` rather than being bundled.

### Discrepancies found in our consumer (the mock follows the vendor, and the tests pin them)

- `createLocation` sends `city: line2` and never declares `$line2`, so Healthie stores the
  second address line as the city.
- `updateCheckoutPatientById` sends a `timezone` variable that the document never declares,
  so Healthie ignores it.
- `FormsService.formRequestStatus` reads `recipient.id`, which its query never selects. The
  cache key it deletes is therefore `…:undefined`.
- `pauseBillingItem` types `isPaused` as a string. A string sent into `$is_paused: Boolean`
  would be rejected by GraphQL variable coercion. The method has no callers today.

### Deliberately not modelled

- Every Healthie operation our consumer no longer calls: appointments, providers, metrics,
  goals, charting, chat, webhooks management, Stripe card mutations, `createClient`/`signUp`,
  `userGroup`, `offeringCoupons`, `createApiKey`, `updateFolder`/`deleteFolder`,
  `updateDocument`. Querying one fails GraphQL validation, as a typo would.
- Healthie's webhook signatures (`Content-Digest` / `Signature`). Our receivers verify only the
  source IP, so deliveries are unsigned.
- Real pagination cursors: `should_paginate` pages by 10 from `offset`. Fuzzy keyword search is
  a case-insensitive substring match over email and names.
- Onboarding flows, Apple Health and Google Fit links: always `null`.
- The live data of a real org. Seed data is synthetic; add users and records through the admin
  routes.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `HealthieAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `userForKey(key)`, `emit(event)`, `fileUrl(origin, fileId)`, `state`. Options: `sqlite`, `now`, `namespace`, `publicNamespace`, `settings`, `onEvent`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets, webhooks). Options: `settings`, `webhooks: {baseUrl, ip?, retryDelaysMs?, fetch?}`, `clock`, `seed`, `adminKey`, `onLog`. |
| `HEALTHIE_PRESETS` | object | Every named fault preset. |
| `HEALTHIE_EVENT_ROUTES` | object | Receiver path → event types delivered there. |
| `healthieEndpoints` | function | The webhook endpoints for a backend base URL and source IP. |
| `DEFAULT_WEBHOOK_IP` | string | `18.206.70.225`, the default `x-forwarded-for`. |
| `HEALTHIE_NAMESPACE` | string | The service name, `"healthie"`. |
| `INVALID_API_KEY` | string | `"API Key is Invalid"`. |
| `HEALTHIE_SDL`, `healthieSchema` | values | The GraphQL schema subset (SDL and the built `GraphQLSchema`). |
| `Upload` | class | A file bound to an `Upload` variable by the multipart transport. |
| `apiKeyOf` | function | The API key an `Authorization` header carries (how credentials map to namespaces). |
| `healthieTimestamp` | function | Healthie's `YYYY-MM-DD HH:MM:SS +0000` timestamp format. |
| `parseShareUsers` | function | `"user-1,user-2"` → `["1", "2"]`. |
| `SEED`, `DEFAULT_SETTINGS` | objects | Seeded ids and credentials; default settings. |
| `document`, `operationIds`, `supportedOperationIds` | values | The HTTP contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8816. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
