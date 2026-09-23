# Cove — a full-stack Mockingbird example

**Cove** is a branded, consumer-facing lab-testing app: a patient signs in with Google or Apple,
shops lab tests, pays through a hosted checkout page, and the paid order is fulfilled as a real
lab order — all persisted to a real (Postgres-dialect) database, in one process, with **zero real
network calls**.

It also runs as a **self-contained, in-browser component** — see `/examples/medical-testing` on
the docs site, where the entire app (client, server, and database) is mounted and runs inside a
single `<app-example>` on the page, no server to start.

## Ports and adapters

Cove's own code — everything under `src/app/` and `src/client/` — never imports Mockingbird, has
no concept of "mocking" or "testing," and doesn't know it's running against mocks at all. It's
written the way a real production app would be:

```
src/app/
  ports/        Db, PaymentsClient, LabTestingClient, IdentityProvider — plain interfaces,
                shaped after real Postgres/Stripe/Vital/OIDC integrations
  db/           repositories (users, lab tests, orders) — built only on the Db port, fully async
  auth/         session management, built only on the IdentityProvider port
  catalog/      the shop's seed data
  checkout/     domain logic: create a checkout, handle a payments webhook, handle a
                lab-testing webhook
  orders/       the order read model (reads Cove's own persisted state — every status
                change already arrived via a webhook, nothing is fetched live)
  http/         the Hono app + routes, constructed from nothing but the ports above

src/adapters/   the ONLY place that imports @crvouga/mockingbird-*, oauth4webapi, etc. —
                one file per port, each implementing it against an in-process Mockingbird mock

src/composition/  wires a real adapter into every port and boots the app — the ONLY place
                  that imports from both app/ and adapters/
```

Swap every file under `src/adapters/` for ones that call real Google/Apple, real Stripe, a real
lab-testing API, and a real Postgres connection, and nothing under `src/app/` or `src/client/`
would need to change.

## What it demonstrates

- **A real OAuth 2.0 / OIDC dance against a mock.** `src/adapters/identity/oauthMockIdentity.ts`
  drives full discovery, PKCE, state/nonce, the account chooser, consent, authorization-code
  exchange, JWKS signature verification, and userinfo — using
  [`oauth4webapi`](https://github.com/panva/oauth4webapi) exactly as you would against real
  Google/Apple, with every request dispatched straight into `OAuthAPI.fetch()` in-process. The
  client's `OAuthModal` component renders the provider's real, server-rendered HTML (account
  chooser → consent) inline in an iframe and drives the flow by intercepting form submits —
  nothing is faked or admin-shortcut; it's the actual protocol.
- **A real hosted checkout, no admin bypass.** `src/adapters/payments/stripeMockPayments.ts`
  creates a real Checkout Session and opens its real hosted payment page
  (`GET/POST /c/pay/:sessionId`, already fully functional in the Stripe mock — card entry, decline
  handling, and a real redirect on completion). The client's `CheckoutModal` drives it the same way
  `OAuthModal` drives sign-in: render the real hosted page, intercept its form submit, follow the
  redirect back.
- **Real, signature-verified webhooks.** Payment completion is delivered as an actual HTTP-shaped
  round trip: `src/adapters/payments/stripeMockPayments.ts` signs the event exactly like real
  Stripe (`Stripe-Signature: t=…,v1=HMAC-SHA256(...)`) and posts it to this app's own
  `/api/webhooks/payments` route, which verifies it before acting — the same pattern a production
  webhook integration uses, just with no real socket underneath.
- **The order settles on its own.** There's no manual "advance" control anywhere in the app.
  `src/adapters/labTesting/junctionMockLabTesting.ts` schedules the order's progression on a short
  timer after it's placed and delivers a webhook to `/api/webhooks/lab-testing` when results are
  ready — the Orders page just polls and reflects whatever is actually persisted.
- **A real SQL database, accessed like any other async client.** The `Db` port
  (`src/app/ports/db.ts`) is a one-method, promise-based interface —
  `query<T>(sql, params): Promise<T[]>` — exactly like `pg`'s `pool.query`. Its adapter
  (`src/adapters/db/postgresMockDb.ts`) runs real `CREATE TABLE`/`INSERT`/`SELECT` SQL against
  `@crvouga/mockingbird-service-postgres`'s in-memory `Database`, wrapped in promises so the port's
  contract holds regardless of what's underneath.

## Run it

**In the browser, no server:** visit `/examples/medical-testing` on the docs site and click
"Launch the app" — everything runs in that tab.

**As a standalone dev server:**

```bash
bun install                      # from the repo root, once
cd packages/examples/medical-testing
bun run dev                      # http://localhost:4300
```

or from the repo root: `bunx turbo run dev --filter=@crvouga/mockingbird-example-medical-testing`.

Click **Continue with Google** or **Continue with Apple**, pick the seeded account, approve
consent, pick a test or two, pay with `4242 4242 4242 4242` (or `4000 0000 0000 0002` to see a
decline), then watch **Orders** — the order fulfills and settles into results on its own, no
button to press.

## Walking the API by hand

Both the OAuth sign-in and the hosted checkout are form-driven (see `checkout-flow.test.ts` for
the exact shape, driven step by step against `app.request()`), so this isn't a single curl
one-liner — that test is the clearest reference for the whole flow, including the automatic
settle-to-results progression.

## Known limitations (intentionally out of scope)

- One seeded account per provider (`ada@example.test` for Google, `grace@example.test` for
  Apple) — no real account creation flow beyond what the OAuth mock's own "Create a new account"
  screen offers.
- Sessions are an in-memory `Map`; this is not how you'd build session storage for anything real.
- One hardcoded patient address/phone on every lab order — no real intake form.
- The standalone server's client bundle is rebuilt once at process startup with `Bun.build`
  rather than served by a dev-mode bundler with hot reload.
