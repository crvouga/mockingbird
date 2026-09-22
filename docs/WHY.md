# Why Mockingbird

Your tests are only as honest as the fakes they run against. Most suites that touch Stripe, Twilio
or a lab partner either call a shared sandbox or stub the client. Both fail in ways that are
expensive to notice. Mockingbird is a third option.

## The two usual options

**Call the vendor's sandbox.**

- Slow round trips on every test, and rate limits under parallel CI.
- Shared accounts: one suite's data leaks into another's, and caps like "50 test users" run out.
- Keys in CI, and outages you did not cause failing your build.
- Hard to reach the edges: declines, 429s, webhooks arriving late or twice.

**Stub the client.**

- The stub returns what you assumed, so the test checks your assumption, not the API.
- No state: create-then-list, pagination and lifecycles are hand-scripted per test.
- Stubs drift from the vendor silently. The bug shows up in production.
- Every team writes its own, for every vendor.

## What Mockingbird does instead

Each package is a working stand-in for one vendor. It answers the vendor's real paths with the
vendor's real response and error shapes, keeps records in an in-memory SQL engine, and runs inside
your test process through a plain `fetch(Request) → Response`. You point the official SDK at it,
or call it directly.

- **Stateful.** A customer you create is there when you list customers. Orders move through their
  states, subscriptions renew when you move the clock, and webhooks are signed and delivered.
- **Contract-driven.** Every HTTP mock is built against a vendored OpenAPI contract, and each
  package lists the operations it does not mock yet, with a reason for each gap.
- **Controllable.** The same admin surface everywhere: reset, snapshot and restore, a controllable
  clock, named fault presets, a request journal, and isolation by namespace so parallel workers
  share one process safely.
- **Portable.** Most packages are plain portable JavaScript that runs in Node, Bun, browsers and
  Workers. The playgrounds on the docs site run the published code in your browser tab.

## How the mocks stay honest

A mock is only useful if it behaves like the vendor. Mockingbird checks that continuously with
property-based tests driven by each contract (details in [TESTING.md](TESTING.md)):

1. **Self-parity, in CI.** Random stateful walks generated from the OpenAPI spec run against two
   independent instances. They must agree after every step, and every response must conform to
   the spec.
2. **Live parity, with credentials.** The same walks run against the vendor's real sandbox and a
   fresh mock. Responses are canonicalized (ids, timestamps, tokens) and diffed, and failures
   shrink to a minimal reproduction.
3. **Consumer acceptance.** Each package drives a port of the consuming app's own client and
   webhook code, and where the app uses the vendor SDK, the SDK is pointed at the mock.

## Release tiers

Every service declares a release tier, **Ready** or **Work in progress**, in its `package.json`.
The README, the docs site, `llms.txt` and `catalog.json` all show it, generated from that one
field; the tier definitions and the current list are in the [README](../README.md#services).

## Docs that cannot drift

Nothing about a service is written down twice. Names, categories, tiers, surfaces and runtimes
come from each package's `package.json`. Operations and coverage come from the built module's
contract. A service's documentation is its package README, the same file npm ships.

The repo README is generated from those same sources (`bun run readme:sync`), and CI fails when it
is stale. The docs site renders the package READMEs, these guides and the same shared copy at
build time. It sends every playground sample request to a fresh mock and runs the quick start and
every SQL snippet against the real packages, so an example that stops working fails the build.

## For coding agents

Agents integrate a mock the same way people do, so the same sources are published in forms they
read well: [`llms.txt`](../llms.txt) indexes every service by tier, each package README is the
integration guide (also at `node_modules/<package>/README.md`), and the docs site serves every
README as markdown at `/services/<name>.md`, all of them in `/llms-full.txt`, and a machine-readable
`/catalog.json`.

## When not to use it

- For a final check against the real vendor before a release. Run a small live suite for that.
  Mockingbird's own live parity exists for the same reason.
- For vendor behavior a mock does not model yet. Each package's README and `SUPPORT.md` say what
  is deliberately not modelled.
