# Lab ordering workspace — an isomorphic full-stack example

A lab-testing workspace with patient, clinician, and administrator roles. Sign in with an emailed
code or with Google or Apple, verify a phone number, build an order, pay through hosted checkout,
track fulfillment, inspect biomarker reports, record clinical reviews, and download records. Every
step sends the messages a real product would: email through Resend, SMS, WhatsApp and one-time
codes through Twilio, push through FCM, and staff alerts through Slack. State lives in a Postgres-dialect database in one
process. Both run modes use the same frontend, HTTP routes, permissions, and repositories.

It also runs as a self-contained, in-browser component — see `/examples/medical-testing` on the
docs site, where the entire app (client, server, and database) is mounted and runs inside a
reusable fullscreen example view, no server to start. That view is the shared dashboard from
`@crvouga/mockingbird-notifications/ui` (`mountDashboard`) with three tabs: **Example** (the app),
**Emulators** (one admin UI for every emulator) and **Notifications** (every message the app sent,
on a phone, a mailbox and a chat window).

## Ports and adapters

The application's domain and HTTP code under `src/app/` use plain application contracts and
never import Mockingbird. The client uses those HTTP routes; its administration page renders
the shared React and Ant Design UI through the same scoped fetch in both run modes. The
synthetic report generator is explicit demonstration
data; it must be replaced with a provider report ingestion path for a real deployment:

```
src/app/
  ports/        Db, PaymentsClient, LabTestingClient, IdentityProvider, Notifier,
                PhoneVerifier — plain interfaces, shaped after real Postgres/Stripe/Vital/OIDC
                and email/SMS/push/chat integrations
  db/           repositories (users, lab tests, orders) — built only on the Db port, fully async
  auth/         session management on the IdentityProvider port, and passwordless email
                sign-in (hashed, expiring, single-use codes and links)
  notifications/  what gets sent and to whom: one branded email layout, the patient's order
                updates, account and security messages, staff alerts, and preferences
  catalog/      the shop's seed data
  checkout/     domain logic: create a checkout, handle a payments webhook, handle a
                lab-testing webhook
  orders/       the order read model (reads the app's own persisted state — every status
                change already arrived via a webhook, nothing is fetched live)
  http/         the Hono app + routes, constructed from nothing but the ports above

src/adapters/   the ONLY place that imports @crvouga/mockingbird-*, oauth4webapi, etc. —
                one file per port, each implementing it against an in-process Mockingbird emulator

src/composition/  wires a real adapter into every port and boots the app — the ONLY place
                  that imports from both app/ and adapters/
```

Swap every file under `src/adapters/` for ones that call real Google/Apple, real Stripe, a real
lab-testing API, and a real Postgres connection, and the application can keep the same
architecture. Production deployment also needs durable sessions, real patient
intake, provider report ingestion, and persistent infrastructure.

## What it demonstrates

- **A real OAuth 2.0 / OIDC dance against an emulator.** `src/adapters/identity/oauthMockIdentity.ts`
  drives full discovery, PKCE, state/nonce, the account chooser, consent, authorization-code
  exchange, JWKS signature verification, and userinfo — using
  [`oauth4webapi`](https://github.com/panva/oauth4webapi) exactly as you would against real
  Google/Apple, with every request dispatched straight into `OAuthAPI.fetch()` in-process. The
  client's `OAuthModal` component fetches the provider's real, server-rendered HTML (account
  chooser → consent), pastes it into the modal, and drives the flow by intercepting form submits —
  nothing is faked or admin-shortcut; it's the actual protocol.
- **A real hosted checkout, no admin bypass.** `src/adapters/payments/stripeMockPayments.ts`
  creates a real Checkout Session and opens its real hosted payment page
  (`GET/POST /c/pay/:sessionId`, already fully functional in the Stripe emulator — card entry, decline
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

## Notifications

Everything below goes through the `Notifier` and `PhoneVerifier` ports and shows up in the
Notifications tab (or `/notifications/` on the standalone server).

| Flow | Channel | Emulator |
| --- | --- | --- |
| Sign-in code and one-click link | Email | Resend |
| Welcome on first sign-up, "new sign-in" alert on later ones | Email | Resend |
| Phone verification code, by SMS or WhatsApp | Text | Twilio Verify |
| "Number verified" confirmation | Text | Twilio |
| Order confirmation with an itemized receipt | Email, text, push | Resend, Twilio, FCM |
| Payment declined | Email | Resend |
| Kit shipped, with tracking | Email, text, push | Resend, Twilio, FCM |
| Sample received | Text, push | Twilio, FCM |
| Results ready | Email, text, push | Resend, Twilio, FCM |
| Clinician review recorded | Email, push | Resend, FCM |
| New paid order (`#lab-orders`) | Chat | Slack |
| Results awaiting review, Block Kit (`#clinical-review`) | Chat | Slack |
| Payment declined (`#billing-alerts`) | Chat | Slack |
| "Send a test notification" in Account | Any | All four |

- **Email sign-in** (`src/app/auth/emailSignIn.ts`, `src/app/http/routes/emailAuth.ts`). A six-digit
  code and a link, stored only as salted hashes. Both expire after 10 minutes, work once, and are
  replaced by a newer email. Five wrong guesses burn the code, and a new one can be requested
  every 30 seconds. The three demo accounts sign in by their addresses; any other address creates
  a patient account. Embedded in the docs site the link has nowhere to point, so the code field
  also accepts the pasted link; on the standalone server the link works when clicked.
- **Phone verification** (`src/app/http/routes/account.ts`). Twilio Verify sends and checks the
  code; the number is saved only after an approved check, and order texts go to it by SMS or
  WhatsApp, whichever the member chose.
- **Push.** Each member has a fictional iPhone and Android phone (`push_devices`), so both skins
  appear. Pushes carry `data` a client would route on: `type`, `orderId`, `orderRef`, `deepLink`.
- **Preferences.** Account has a switch per channel for order updates. Security messages (codes,
  sign-in alerts) and tests the member asks for always send; staff alerts are not the patient's
  to switch off.
- **Finding the message.** Wherever the app says "we sent you…", an **Open Notifications** button
  opens that recipient on that device. `src/client/inbox.ts` is the seam: a new tab on the
  standalone server, a tab switch in the dashboard.

`notifications.test.ts` drives all of it through the HTTP app and reads the messages back with the
harness (`waitFor`, `NotificationClient.waitForCode`), including expiry, reuse, attempt limits,
the resend cooldown and preferences.

## Run it

**In the browser, no server:** visit `/examples/medical-testing` on the docs site and click
"Launch the app". The fullscreen view is one dashboard: the example, one shared emulator admin, and
the notifications it sent, each on its own tab. A
global selector switches that admin between Google, Apple, Stripe, Junction, Twilio, Resend, FCM, Slack, and Postgres while
each independent admin API remains directly composable and operates on the same in-process state
the app uses. The selected emulator, admin screen, namespace, and local UI state remain mounted when
switching tabs. Every administration screen uses prebuilt Ant Design tables, forms,
dialogs, navigation, and feedback. Postgres includes the SQL table explorer and query runner alongside state,
clock, faults, journal, and routes. SQL changes appear in the app immediately; checkpoint and
restore operate on this same database. New services and data sources join the same admin tab registry.

**As a standalone dev server:**

```bash
bun install                      # from the repo root, once
cd packages/examples/medical-testing
bun run dev                      # http://localhost:4300, notifications at /notifications/
```

or from the repo root: `bunx turbo run dev --filter=@crvouga/mockingbird-example-medical-testing`.

Pick a demo account and choose **Email me a sign-in code** (the code is in the Notifications tab),
or click **Continue with Google** or **Continue with Apple**, pick the seeded account and approve
consent. Then pick a test or two, pay with `4242 4242 4242 4242` (or `4000 0000 0000 0002` to see a
decline), then watch **Orders** — the order fulfills and settles into results on its own, no
button to press. Each step sends its email, text and push.

## Workspace features

- Searchable test catalog, category filters, itemized cart, order acknowledgment, and hosted payment.
- Loading, empty, error/retry, and success states; active orders refresh automatically.
- Resume an unpaid checkout from its order details.
- Detailed reports with biomarker values, units, synthetic reference ranges, flags, and prior samples.
- Persisted, timestamped timelines for order placement, payment, shipping, processing, results, and review.
- Clinician notes recorded with reviewer identity and timestamp, visible to the patient.
- Download results as CSV, itemized receipts as TXT, and complete order records as JSON.
- Editable profile, a verified phone number, a switch per notification channel, and a "send a
  test" button for each channel.
- Passwordless email sign-in next to Google and Apple.
- Administration with member search, confirmed role changes, a permission matrix, and an audit log.
- Generic responsive styling with system fonts, light/dark support, and reduced-motion support.

| Role | Access |
| --- | --- |
| Patient | Own orders, checkout, reports, downloads, and profile |
| Clinician | Patient access plus all patient orders and clinical review |
| Administrator | Clinician access plus member roles and audit history |

Permissions are enforced in HTTP handlers, including downloads and hosted checkout ownership.
Administrators cannot change their own role. Changing another member's role takes effect on their
next request, even in an existing session. Reviews and downloads appear in the audit log.

Ada starts with two fictional completed reports, one reviewed and one awaiting review. Switch
accounts by signing out in **Account**. Closing and reopening the docs example resets its running
instance. Standalone state lasts for the server process. No external avatar or font requests.

## Walking the API by hand

Both the OAuth sign-in and the hosted checkout are form-driven (see `checkout-flow.test.ts` for
the exact shape, driven step by step against `app.request()`), so this isn't a single curl
one-liner — that test is the clearest reference for the whole flow, including the automatic
settle-to-results progression.

## Known limitations (intentionally out of scope)

- Google offers Ada Lovelace (patient), Morgan Chen (clinician), and Alex Morgan (administrator).
  Apple offers Grace Hopper (patient). Newly created OAuth accounts start as patients.
- Sessions are an in-memory `Map`; this is not how you'd build session storage for anything real.
- One hardcoded patient address on every lab order (the phone is the member's verified number) —
  no real intake form.
- Orders cannot be cancelled or refunded, so there are no cancellation or refund messages.
- Sign-in codes are rate-limited per address only; a real deployment also limits per client.
- The standalone server's client bundle is rebuilt once at process startup with `Bun.build`
  rather than served by a dev-mode bundler with hot reload.
