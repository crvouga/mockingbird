# Why Mockingbird

Mockingbird gives applications local, stateful emulators for the vendor APIs and databases
they depend on. Run integrations inside your process, control the state and clock, and inspect
exactly which vendor operations each emulator supports.

## Local execution

Each HTTP emulator accepts the vendor's request paths, headers, and payload shapes through
`fetch(Request) → Response`. It returns vendor-compatible responses and error envelopes,
and stores records in an in-memory SQL engine. Run the ones your application calls as a [fleet](FLEETS.md): one `mockingbird.json`, one
`mockingbird-fleet serve --dashboard`, each emulator on its own port, and one dashboard for their
admin UIs and the notifications your app sent. Then point each official SDK at its emulator's URL.
In a test that can inject a `fetch`, hand the client the emulator's Fetch handler instead and no
port is opened at all.

The runtime gives development and CI the same controls: isolated namespaces, reproducible
randomness, reset, snapshots, faults, and request journals. Exercise payment declines, rate
limits, and repeated webhook deliveries using the service's documented controls.

## Stateful emulation

- **Stateful.** A customer you create is there when you list customers. Orders move through their
  states, subscriptions renew when you move the clock, and webhooks are signed and delivered.
- **Contract-driven.** Every HTTP emulator is built against a vendored OpenAPI contract, and each
  package lists the operations it does not emulate yet, with a reason for each gap.
- **Controllable.** The same admin surface everywhere: reset, snapshot and restore, a controllable
  clock, named fault presets, a request journal, and isolation by namespace so parallel workers
  share one process safely.
- **Isomorphic.** Every emulator is the same package in Node, Bun, browsers, and Workers. The
  playgrounds on the docs site run that package in your browser tab.

## Verification against contracts and oracles

Mockingbird verifies the supported behavior with
property-based tests driven by each contract (details in [TESTING.md](TESTING.md)):

1. **Self-parity, in CI.** Random stateful walks generated from the OpenAPI spec run against two
   independent instances. They must agree after every step, and every response must conform to
   the spec.
2. **Live parity, with credentials.** The same walks run against the vendor's real sandbox and a
   fresh emulator. Responses are canonicalized (ids, timestamps, tokens) and diffed, and failures
   shrink to a minimal reproduction.
3. **Consumer acceptance.** Each package drives a port of the consuming app's own client and
   webhook code, and where the app uses the vendor SDK, the SDK is pointed at the emulator.

## Parity

Every service declares its own parity in `package.json` as `mockingbird.parity`: a short
statement of the vendor surface it keeps in step. The docs site, `llms.txt` and `catalog.json`
show that statement, generated from that one field. The current list is the
[services catalog](https://mockingbird.chrisvouga.dev/services).

## Docs that cannot drift

Nothing about a service is written down twice. Names, categories, parity, and surfaces
come from each package's `package.json`. Operations and coverage come from the built module's
contract. A service's documentation is its package README, the same file npm ships.

The repo README is the short overview (`bun run readme:sync`), and CI fails when it is stale. The
name, the sentence, and the mark live in `sites/docs/src/lib/content.ts`. The README header,
`llms.txt`, and the opening line of every published package README are generated or checked from
that file. The catalog of emulators is the docs site, `llms.txt`, and `catalog.json`. The rules are in
[docs/DESIGN.md](DESIGN.md). The docs site renders the package
READMEs, these guides and the same shared copy at build time. It sends every playground sample request to a fresh emulator and runs the quick start and
every SQL snippet against the real packages, so an example that stops working fails the build.

## For coding agents

Agents integrate an emulator the same way people do, starting with a [fleet](FLEETS.md#quick-start), so the same sources are published in forms they
read well: [`llms.txt`](../llms.txt) indexes every service with the parity it declares, each package README is the
integration guide (also at `node_modules/<package>/README.md`), and the docs site serves every
README as markdown at `/services/<name>.md`, all of them in `/llms-full.txt`, and a machine-readable
`/catalog.json`.

## When not to use it

- For a final check against the real vendor before a release. Run a small live suite for that.
  Mockingbird's own live parity exists for the same reason.
- For vendor behavior an emulator does not model yet. Each package's README and `SUPPORT.md` say what
  is deliberately not modelled.
