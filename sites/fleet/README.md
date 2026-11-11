# Mockingbird Fleet Cloud

A self-hostable, multi-tenant service that hosts [fleets](../../docs/FLEETS.md) of Mockingbird
emulators at stable URLs and keeps their state in object storage. It ships as one stateless Docker
image: the control API, the dashboard and all 122 HTTP emulators.

```
organization ── members, invites, API keys
  └─ project
       └─ fleet     https://<host>/f/<fleet-slug>
            └─ emulator   https://<host>/f/<fleet-slug>/<name>   ← point the vendor SDK here
```

```sh
bun run --cwd sites/fleet dev      # http://localhost:8080, in-memory storage, local sign-in
bun test --cwd sites/fleet         # includes real PostgreSQL and the S3 / OTLP emulators
```

## Declare it: `mockingbird.yaml`

The prescribed way to configure Fleet Cloud is one file, kept in your repository, that declares
an organization's projects, fleets and emulators. The same file runs the fleet on your machine.

```yaml
# mockingbird.yaml
version: 1
organization: acme            # slug; created on the first apply
name: Acme
projects:
  web:
    name: Web app
    fleets:
      acme-staging:           # the fleet's URL: /f/acme-staging
        access: open          # or: key
        requestsPerMinute: 600
        services:
          stripe: { durability: strict }
          resend: {}          # every default: target resend, durability buffered
          billing: { target: stripe, seed: "42" }
          db: { target: postgres, protocol: postgres, port: 5432, local: true }
```

```sh
export MOCKINGBIRD_FLEET_URL=https://mockingbird-fleet.chrisvouga.dev
export MOCKINGBIRD_FLEET_TOKEN=mbf_…       # a personal token, or an admin API key

npx mockingbird-fleet plan                 # what would change; changes nothing
npx mockingbird-fleet apply                # make Fleet Cloud match the file
npx mockingbird-fleet apply --prune        # …including deleting what the file no longer declares
npx mockingbird-fleet serve --config mockingbird.yaml   # the same fleet, on this machine
```

No CLI is needed for the cloud half; the API takes the file as it is:

```sh
curl -X PUT "$MOCKINGBIRD_FLEET_URL/api/v1/manifest?dryRun=true" \
  -H "Authorization: Bearer $MOCKINGBIRD_FLEET_TOKEN" \
  -H 'content-type: application/yaml' --data-binary @mockingbird.yaml
```

- **One format, two places.** A fleet's `services` are the entries of a local fleet configuration
  ([Fleets](../../docs/FLEETS.md)), so `serve` runs them unchanged. Fleet Cloud adds `durability`,
  `flushIntervalMs`, `webhookOrigins`, and the fleet's `access` and `requestsPerMinute`; a local
  fleet ignores those. Local keys such as `port` are ignored by the cloud. A service marked
  `local: true` runs only locally: use it for PostgreSQL and Redis, which a hosted fleet cannot
  offer.
- **The file is the whole truth.** Applying makes the organization's projects, fleets and
  emulators match it. What it no longer declares is deleted, with its stored state, only when
  you pass `--prune` (`?prune=true`); without it the apply is refused and lists what would go.
  Applying the same file twice changes nothing, and emulator state is kept across applies unless
  an emulator is removed or becomes a different emulator.
- **A managed organization is read-only everywhere else.** Once a file has been applied, the
  dashboard shows the configuration without controls to change it, and the API answers
  `409 managed_by_declaration` to hand edits of projects, fleets and emulators. Operating a fleet
  (resetting or saving state), and managing members and API keys, stay available.
  `DELETE /orgs/{id}/manifest` releases the organization back to manual control without deleting
  anything.
- **Start from what you have.** `GET /orgs/{id}/manifest` (dashboard: the organization's
  *Configuration* tab) returns any organization as a `mockingbird.yaml`. Applying that file
  changes nothing and puts the organization under the file's control.
- **Validated before anything changes.** Every problem is reported at once with the path of its
  key (`projects.web.fleets.acme-staging.services.stripe.durability: must be one of …`).

Members, invites and API keys are not declared in the file: they are people and secrets.

## Durability, per emulator

Every emulator in a fleet chooses how much of its state survives. Change it at any time in the
dashboard or with `PATCH /fleets/{id}/emulators/{name}`; it takes effect on the next request.

| Mode | A response is sent… | Lost in a crash | Cost |
| --- | --- | --- | --- |
| `strict` | after the state change is committed to object storage | nothing acknowledged | Slowest. Each request reads the committed state and writes it back with a compare-and-swap, so requests to one emulator run one at a time and responses are buffered (no streaming). Safe with any number of replicas. |
| `buffered` (default) | immediately, from memory | up to `flushIntervalMs` (default 2 s) | Fast. State is written shortly after the first unsaved change and at shutdown. Replicas do not merge: if two write, the later save loses and reloads. |
| `ephemeral` | immediately, from memory | everything | Fastest. Nothing is stored; switching to it deletes the stored copy. |

State is one gzipped JSON object per emulator at `<S3_PREFIX>/fleets/<fleet id>/<name>/state.json.gz`,
written only with `If-Match` / `If-None-Match`. Everything the process holds in memory is a cache
of those objects, which is what makes the container stateless.

## For agents: everything is an API call

The dashboard is a client of the API and nothing else. The contract is OpenAPI 3.1, served at
`/api/openapi.json` and committed as [`openapi.json`](openapi.json) (a test fails when it is stale).

A person creates a personal token once (dashboard → Account). From there an agent commits a
`mockingbird.yaml` and applies it (above). The same resources can also be driven one call at a
time, in an organization that is not managed by a file:

```sh
API=https://mockingbird-fleet.chrisvouga.dev/api/v1
auth="Authorization: Bearer $MOCKINGBIRD_FLEET_TOKEN"

org=$(curl -fsS -H "$auth" -H 'content-type: application/json' -d '{"name":"Acme"}' $API/orgs | jq -r .id)
project=$(curl -fsS -H "$auth" -H 'content-type: application/json' -d '{"name":"Web"}' $API/orgs/$org/projects | jq -r .id)
curl -fsS -H "$auth" -H 'content-type: application/json' $API/projects/$project/fleets -d '{
  "name": "Staging", "slug": "acme-staging",
  "emulators": {
    "stripe": { "target": "stripe", "durability": "strict" },
    "resend": { "target": "resend", "durability": "buffered" }
  }
}'
# → emulators.stripe.url = https://mockingbird-fleet.chrisvouga.dev/f/acme-staging/stripe
```

| Credential | Looks like | Acts as |
| --- | --- | --- |
| Personal token | `mbf_u_…` | its user, in every organization they belong to |
| Organization key | `mbf_o_…` | a `viewer`, `member` or `admin` of one organization |
| Project key | `mbf_p_…` | a `viewer` or `member` of one project |

Roles are `viewer` < `member` < `admin` < `owner`. Keys are shown once and stored as SHA-256
hashes. A key can never outrank whoever created it.

Calling an emulator needs no Mockingbird credential when the fleet's access is `open` (the vendor
SDK only knows the vendor's own auth). Set access to `key` to require `x-mockingbird-api-key` on
every request. Each emulator's `/__admin/*` routes always require that header with a `member` key.

## Self-hosting

One stateless image. It needs a PostgreSQL database and an S3-compatible bucket, both given as
environment variables; nothing is written to the container's disk, so run as many replicas as you
like behind any load balancer.

```sh
# Try it: no dependencies, data in memory, sign in by typing an email (loopback only).
docker run --rm -p 8080:8080 -e AUTH_DEV_LOGIN=1 ghcr.io/crvouga/chrisvouga-mockingbird-fleet

# Run it for real: copy .env.example to .env and fill in the REQUIRED block.
docker run --rm --env-file .env <image> bun dist/main.js check   # validate, then exit
docker run -d --env-file .env -p 8080:8080 <image>
```

[`.env.example`](.env.example) lists every variable. The minimum for a real deployment is
`PUBLIC_URL`, `DATABASE_URL`, the five `S3_*` variables and one way to sign in (`OPERATOR_TOKEN`,
or `OIDC_ISSUER` + `OIDC_CLIENT_ID`).

### It fails fast, and says how to fix it

Before listening, the server validates every variable, connects to PostgreSQL, creates its
schema, and writes, reads and deletes a probe object in the bucket (which also proves the store
honours conditional writes). If anything is wrong it exits with code **78** and never reports
healthy. The report lists every problem at once, each with the reason, the fix and the variable:

```
mockingbird-fleet cannot start: 2 problems to fix

1. S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET are not set
   why: Emulator state is stored in an S3-compatible object store. PUBLIC_URL is https://fleet.example.com, which is not a loopback address, so this is treated as a real deployment; the in-memory store exists for localhost development only.
   fix: Set all five variables for any S3-compatible store that supports conditional writes (Cloudflare R2, AWS S3, MinIO). The bucket must already exist.
   set: S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com   (or https://s3.<region>.amazonaws.com, http://minio:9000)
   set: S3_REGION=auto   (R2 and MinIO: auto; AWS: the bucket's region, e.g. us-east-1)
   ...
2. PostgreSQL rejected the username or password in DATABASE_URL
   why: ... The driver reported: password authentication failed for user "fleet"
   fix: Correct the user and password in DATABASE_URL. Special characters in a password must be percent-encoded (@ → %40, : → %3A, / → %2F).
   set: DATABASE_URL=postgres://<user>:<password>@<host>:5432/<database>
```

The last line of the output is the same list as one JSON object
(`{"level":"fatal","event":"startup_failed","problems":[{code, what, why, fix, env}]}`) for tools.
Secret values are never printed. Distinguished causes include: missing or half-set variables;
unsafe settings (dev login on a public URL, a short operator token); a wrong database password,
missing database, unreachable host, TLS mismatch or missing schema rights; a missing bucket, bad
signature, denied access, unreachable endpoint or a store without conditional writes.

## Limits, rate limits and abuse protection

Everything here is configurable with environment variables (defaults in
[`.env.example`](.env.example)); `0` means unlimited.

**Quotas** apply per organization: projects, fleets, emulators per fleet, members, API keys,
stored state per emulator, and emulator requests per month. Going past one answers
`403 quota_exceeded` (`429` for the monthly request quota) with `details.limit` naming it.
`GET /orgs/{id}/usage` returns an organization's limits, current usage and requests per day.

**Rate limits** answer `429` with `Retry-After`, `RateLimit-Limit` and `RateLimit-Remaining`:

| Limit | Keyed by | Variable |
| --- | --- | --- |
| Control API | credential (address when anonymous) | `RATE_LIMIT_API_PER_MINUTE` |
| Sign-in attempts and rejected credentials | client address | `RATE_LIMIT_AUTH_PER_MINUTE` |
| Emulator requests | client address | `RATE_LIMIT_CLIENT_PER_MINUTE` |
| Emulator requests | fleet | `LIMIT_FLEET_REQUESTS_PER_MINUTE`; a fleet may set a lower `requestsPerMinute` |

Buckets live in each replica's memory, so with N replicas the effective ceiling is up to N times
the configured rate. Set `TRUSTED_PROXY_HOPS` to the number of proxies in front of the server;
otherwise every client appears to share the proxy's address.

**Abuse protection:**

- Each fleet serves at most `FLEET_MAX_CONCURRENT_REQUESTS` at once, and a request that runs past
  `FLEET_REQUEST_TIMEOUT_MS` is answered `504`.
- An emulator whose state outgrows `LIMIT_STATE_BYTES` answers `507`: `strict` rolls the write
  back; `buffered` stops serving until it is reset.
- Emulator control headers (`x-mockingbird-reset`, `-restore`, `-time`, `-fault`, `-delay`, …) and
  `/__admin/*` routes work only with a `member` API key, so a stranger cannot wipe or stall an
  `open` fleet. `x-mockingbird-namespace` is always allowed.
- Emulators make no outbound requests unless `webhookOrigins` lists public https origins.
- After `RATE_LIMIT_AUTH_PER_MINUTE` rejected credentials, an address is refused without its
  credentials being checked.
- Request bodies are capped at 32 MiB (1 MiB for the control API).

**Operator controls** need `OPERATOR_TOKEN` and use it as the Bearer credential:

```sh
# Raise one organization's quotas (null restores the default), or suspend it.
curl -X PATCH $API/admin/orgs/$ORG -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'content-type: application/json' -d '{"limits":{"requestsPerMonth":0,"fleetsPerOrg":500}}'
curl -X PATCH $API/admin/orgs/$ORG -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'content-type: application/json' -d '{"suspended":"unpaid invoice"}'
```

A suspended organization's fleets answer `403 org_suspended`, and it can read and delete but not
create or change. `GET /admin/orgs` lists every organization with its usage.

## Integrating another application

- **Contract:** OpenAPI 3.1 at `/api/openapi.json`; an agent-oriented guide generated from this
  server's routes and limits at `/llms.txt`.
- **Credentials:** personal tokens, organization keys and project keys (above). Without an
  identity provider, `POST /admin/users` issues a user and a token.
- **Errors:** always `{"error": {"code", "message", "details"?}}`, with a message that says what to
  do. Every response carries `x-request-id`; send your own to correlate.
- **Audit log:** `GET /orgs/{id}/audit` lists who changed what (kept 90 days).
- **Browser apps:** list their origins in `CORS_ORIGINS` to call the API with an API key.
  Cookies are never accepted cross-origin.
- **Idempotent setup:** fleet, project and organization slugs are unique and permanent, so
  creating with a chosen slug either succeeds or answers `409`.

## Storybook: every screen of the dashboard

The dashboard (`src/ui`) is plain TypeScript: `router.ts` draws the screen for the address,
`screens/` holds one module per screen and `routes.ts` lists them. Storybook mounts that same code
over a mocked `fetch`, one story per screen and state, so the whole product can be browsed without
a server.

```sh
bun run --cwd sites/fleet storybook               # http://localhost:6006
bun run --cwd sites/fleet storybook:build         # static site in storybook-static/
bun run --cwd sites/fleet storybook:screenshots   # every story as a PNG in .tmp/screenshots/
```

A story is an address plus the API's answers (`src/ui/stories/*.stories.ts`, fixtures in
`fixtures.ts`), and optionally what a person then does. `test/stories.test.ts` validates every
answer against the OpenAPI document and fails when a route has no story, or a mutation route has
no story showing it idle, pending, refused at a field, refused as a whole, and succeeded. The
screenshot run captures each story at desktop width, plus phone width and dark mode for the first
story of each screen, writes `manifest.json` beside them, and fails when a story logs an error,
does not draw the state it claims, or breaks a design rule, or when some route or shell state is
drawn by no story.

## Dashboard design rules

1. **A screen is a query or a mutation, never both.** A query shows data and links: no form, no
   control that saves. Each value that can change has a link to its own screen ("Rename",
   "Change", "Remove…").
2. **One mutation per screen.** A mutation screen has its own address, exactly one form, one
   submit button and a Cancel link. There are no modals and no confirmation dialogs; deleting is a
   screen that says what will be lost.
3. **Feedback is inline; there are no toasts.** A problem with a field is written under it
   (`aria-describedby`, `aria-invalid`); a refusal that belongs to no field is summarised inside
   the form (`role="alert"`). While a request is in flight the submit button is disabled and says
   what it is doing. After success the dashboard goes where the result lives and marks it there
   ("Renamed just now"). A secret is shown once, on its own screen.

`routes.ts` declares each route's kind, and `auditSurface` (`src/ui/audit.ts`) checks a drawn
screen against it. Three places run that check: every Storybook story in the screenshot run,
every route against the real server in `specs/features/dashboard/design-rules.feature`, and the
coverage test above for which states must exist.

## Specs: behaviour, in a real browser

`specs/features` holds the behaviour of the service as Gherkin, run by Playwright
(`bun run --cwd sites/fleet spec`) against the real server wired to Mockingbird's own PostgreSQL,
S3 and OTLP emulators. `specs/features/dashboard` drives the built dashboard in Chromium (the run
builds it first; `bunx playwright install chromium` once): every screen, what each role is
offered, sign-in through a real OpenID Connect provider, and that the page requests nothing but
its own files, `/api/v1`, `/api/openapi.json` and `/auth/*`. Steps find controls by role, label
and text, and wait on the `aria-busy` the dashboard sets while it redraws.

## Configuration

Environment variables only; see [`.env.example`](.env.example) for the full list with defaults.

| Variable | Required | Meaning |
| --- | --- | --- |
| `PORT` | no (8080) | Listen port, on `0.0.0.0`. |
| `PUBLIC_URL` | real deployments | Origin of the dashboard and API. Must be https unless loopback. |
| `FLEET_URL` | no | Origin fleets are served from. Defaults to `PUBLIC_URL`; see *Security*. |
| `DATABASE_URL` | real deployments | PostgreSQL URL, passed to the driver unchanged. |
| `DATABASE_SCHEMA` | no (`mockingbird_fleet`) | The only schema this service creates tables in. |
| `S3_ENDPOINT` `S3_REGION` `S3_ACCESS_KEY_ID` `S3_SECRET_ACCESS_KEY` `S3_BUCKET` | real deployments | S3-compatible store, path-style, with conditional writes. |
| `S3_PREFIX` | no (`mockingbird-fleet`) | Key prefix; nothing outside it is read, written or deleted. |
| `OPERATOR_TOKEN` | one sign-in method | 32+ characters. Enables `/admin/*` and operator-issued user tokens. |
| `OIDC_ISSUER` `OIDC_CLIENT_ID` | one sign-in method | OpenID Connect provider, as a public client (code flow, S256 PKCE, no secret). |
| `OIDC_REDIRECT_URI` `OIDC_SCOPES` | no | Default `<PUBLIC_URL>/auth/callback` and `openid email profile`. |
| `AUTH_DEV_LOGIN` | no | `1` enables sign-in by typing an email. Refused unless `PUBLIC_URL` is loopback. |
| `TRUSTED_PROXY_HOPS` | behind a proxy | Proxies in front of the server whose `X-Forwarded-For` entry is trusted. Default 0. |
| `CORS_ORIGINS` | no | Comma-separated browser origins allowed to call the API with a key. |
| `LIMIT_*` `RATE_LIMIT_*` `FLEET_*` | no | Quotas, rate limits and abuse protection (above). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` `OTEL_EXPORTER_OTLP_HEADERS` `OTEL_SERVICE_NAME` | no | OTLP/HTTP JSON export of traces, metrics and logs. |
| `VAULT_ADDR` `VAULT_TOKEN` `VAULT_PROJECT` `VAULT_CONFIG` | no | Read `secret/<project>/<config>` once at boot for any variable not already set. |

On loopback with no `DATABASE_URL` / `S3_*`, storage is in memory, for development only.

### On chrisvouga.dev

| Platform piece | How this service uses it |
| --- | --- |
| Hosting | Service `mockingbird-fleet`, image `ghcr.io/crvouga/chrisvouga-mockingbird-fleet`, port 8080, health `GET /health` (no database, no auth). `GET /ready` checks the database. Set `TRUSTED_PROXY_HOPS=1`. |
| Vault | Secrets are declared in the service inventory and arrive as env vars. `OPERATOR_TOKEN` is the one new key, and only if operator controls are wanted (sessions are database rows, so there is no signing key). |
| PostgreSQL | `DATABASE_URL`, schema `mockingbird_fleet`. Migrations run at boot under an advisory lock and touch only that schema. |
| Object store | The shared R2 bucket, under `mockingbird-fleet/` only. |
| Auth relay | Public PKCE client against `OIDC_ISSUER`. Users are keyed by `(iss, sub)`; an email never links accounts or grants access. |
| OpenTelemetry | Standard `OTEL_*` variables. The cloud guide does not define a collector yet, so export stays off until one is configured. |

## Security

- **Tenant isolation.** Every API read and write is checked against the caller's role in the
  owning organization. A resource the caller cannot see answers 404, not 403.
- **Emulator pages cannot act as the dashboard.** On a shared origin, every fleet response carries
  `Content-Security-Policy: sandbox`, a dashboard session never authorizes a fleet request, and
  session cookies are stripped in both directions. Setting `FLEET_URL` to a second hostname that
  points at the same container separates the two origins outright.
  Fleets still share one origin with each other: per-fleet origins would need wildcard subdomains.
  Do not rely on browser cookies set by an emulator's own pages to separate tenants.
- **No outbound requests by default.** Emulator webhook delivery is off. An emulator may list
  public https origins in `webhookOrigins`; private and loopback hosts are refused. This is an
  allowlist by name, not a network sandbox: it does not defend against DNS rebinding.
- **Browser sessions** are host-only, `HttpOnly`, `SameSite=Lax` cookies; state-changing API calls
  from a session also need the `x-mockingbird-csrf` header.

## Limits

- HTTP emulators only. PostgreSQL, Redis and SQLite speak their own wire protocols and need their
  own ports, which one hosted HTTP port cannot offer.
- One URL path per emulator, not a subdomain: an SDK that cannot take a base URL with a path
  prefix will not work.
- On a shared origin the sandbox gives emulator-served pages an opaque origin, so a hosted page
  that calls back with `fetch` or cookies (a hosted checkout or login screen) can fail. API calls
  from SDKs are unaffected; set `FLEET_URL` to lift this.
- Invites produce a link to share; the service sends no email.
- List endpoints are not paginated (quotas bound their size), and there is no billing, outbound
  event webhooks or `Idempotency-Key` support.
- Rate limits and the monthly request count are approximate across replicas: each replica limits
  on its own, and usage is added to the database every 10 seconds.
- A fleet's configuration is cached per replica for up to 3 seconds, so a change made through one
  replica can take that long to reach requests served by another.
