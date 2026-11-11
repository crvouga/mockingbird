# @crvouga/mockingbird-fleet

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

The recommended way to run Mockingbird: one `mockingbird.json`, one process, every emulator your
application calls on its own port, one controller to reset and snapshot them together, and one
dashboard for their admin UIs and the notifications your app sent. Requires Node.js 22 or newer.

## Install

```sh
npm install -D @crvouga/mockingbird-fleet @crvouga/mockingbird-service-stripe @crvouga/mockingbird-service-twilio @crvouga/mockingbird-service-resend
```

## Quick start

`mockingbird.json`:

```json
{
  "control": { "port": 9000 },
  "services": {
    "stripe": { "port": 9001 },
    "twilio": { "port": 9002 },
    "resend": { "port": 9003 }
  }
}
```

```sh
npx mockingbird-fleet serve --config mockingbird.json --dashboard --ready-file ready.json
# fleet ready: http://127.0.0.1:9000/__admin/fleet
# dashboard:   http://127.0.0.1:8790
```

- **Point your app at it.** `ready.json` lists every emulator's URL as `services.<name>.url`. Use
  `"port": 0` for a free port per emulator, so parallel fleets never collide.
- **Open the dashboard.** The **Emulators** tab is every emulator's admin UI; the
  **Notifications** tab is every SMS, WhatsApp message, email, push and chat message your app sent.
- **Control every emulator at once.** `curl -X POST http://127.0.0.1:9000/__admin/fleet/namespaces/default/reset`
  puts them all back to their boot state; snapshots, restore and the clock work the same way.

A service is named by its package suffix (`stripe` loads `@crvouga/mockingbird-service-stripe`).
Install only the emulator packages your application uses; none is required, Stripe included.
The private `@crvouga/mockingbird-adapter-node` implementation is bundled, never installed separately.
Existing `@crvouga/mockingbird-service-stripe/fleet` imports remain supported with the same API.
The [Fleets guide](https://mockingbird.chrisvouga.dev/docs/fleets) covers the configuration, the
controller's routes and archives.

## Usage

A test runner's global setup can own the fleet instead of the CLI:

```sh
npm install -D @crvouga/mockingbird-fleet @crvouga/mockingbird-service-postgres @crvouga/mockingbird-service-redis @crvouga/mockingbird-service-cognito
```

```ts
import { createInstalledServiceLoader, FleetClient, startFleet } from '@crvouga/mockingbird-fleet'

const fleet = await startFleet({ services: {
  database: { target: 'postgres', port: 0 },
  cache: { target: 'redis', port: 0 },
  identity: { target: 'cognito', port: 0 },
}}, { load: createInstalledServiceLoader({
  projectRoot: process.cwd(), services: ['postgres', 'redis', 'cognito'],
}) })
try {
  const client = new FleetClient(fleet.manifest.adminBase)
  await client.createNamespace('test')
} finally {
  await fleet.close()
}
```

The resolver only loads allowlisted installed service suffixes from their `/server` export,
relative to the explicit consumer project root (including pnpm symlinks). It never installs
packages. Distinct instance names use `target`. A custom `load` callback remains supported.

## CLI

```sh
mockingbird-fleet serve --config mockingbird.json --ready-json     # readiness JSON on standard output
mockingbird-fleet fleet doctor --config mockingbird.json --json    # validate without starting anything
```

`serve` takes `--config` (required), `--ready-json`, `--ready-file <path>`,
`--connections-file <path>` (credential-bearing URLs, mode 0600), `--dashboard`,
`--dashboard-port <n>`, `--project-root <dir>` and `--fleet <slug>`. The directory of a ready or
connections file must already exist. `MOCKINGBIRD_ADMIN_KEY` sets the admin key when the
configuration has none. `fleet control`, `fleet render` and `fleet rehearse` are the other
management commands; `mockingbird-fleet <command> --help` lists each one's options.

`--dashboard` also serves one page with every emulator's admin UI and the
[notifications](https://github.com/crvouga/mockingbird/tree/main/packages/notifications#readme)
they sent, on port 8790 (`--dashboard-port <n>`; `0` picks a free one):

```sh
mockingbird-fleet serve --config mockingbird.json --dashboard
# fleet ready: http://127.0.0.1:9000/__admin/fleet
# dashboard:   http://127.0.0.1:8790
```

`"dashboard": true` or `"dashboard": { "port": 8790 }` in the configuration does the same, and so
does `startFleet(config, { load, dashboard: { port: 0 } })`; the URL is `manifest.dashboard`, in the
ready file too, and it closes with the fleet. `@crvouga/mockingbird-notifications` is a dependency
of this package, so there is nothing more to install. The dashboard sends the fleet's admin key to
the emulators itself: keep it on loopback (the default) or another private address.

The package exports typed lifecycle, client, archives, repositories, discovery, migrations,
participants, connection rendering and extension contracts. Public discovery omits credentials;
write connection files to private paths. Public ingress support is provider-specific.

## One file: `mockingbird.yaml`

`serve --config` takes a fleet configuration in JSON or YAML, or a `mockingbird.yaml`
declaration: the file Fleet Cloud applies. The same file then runs the fleet on your machine.

```yaml
version: 1
organization: acme
projects:
  web:
    fleets:
      acme-staging:
        services:
          stripe: { durability: strict }
          db: { target: postgres, protocol: postgres, port: 5432, local: true }
```

```sh
npx mockingbird-fleet serve --config mockingbird.yaml          # add --fleet <slug> when it declares several
MOCKINGBIRD_FLEET_URL=https://… MOCKINGBIRD_FLEET_TOKEN=… npx mockingbird-fleet plan
npx mockingbird-fleet apply            # --prune also deletes what the file no longer declares
```

Keys only Fleet Cloud reads (`durability`, `flushIntervalMs`, `webhookOrigins`, `local`, and a
fleet's `access` and `requestsPerMinute`) are dropped before a local fleet starts. `plan` and
`apply` take `--file` (default `mockingbird.yaml`), `--url`, `--token-env` and `--json`.

## API

`DASHBOARD_PORT`, `FleetClient`, `FleetClientError`, `FleetClientResponseError`, `FleetInstrumentation`, `FleetObservations`, `FleetRunError`, `NamespacePool`, `RepositoryWriter`, `advertisedHttpBase`, `archiveCompatibility`, `archiveProtector`, `archiveReachability`, `assertArchiveCompatibility`, `assertFleetConfig`, `compactArchive`, `composeFleetSchema`, `createFleetIngress`, `createInstalledServiceLoader`, `diffArchives`, `doctorFleet`, `fileParticipant`, `filesystemConditionalStore`, `filesystemOperationJournal`, `filesystemRepository`, `fleetCommands`, `fleetDashboard`, `fleetConfigSchema`, `incrementalArchive`, `ingressSupport`, `inspectArchive`, `launchFleet`, `listen`, `materializeArchive`, `migrateAndVerify`, `migrateApplicationArchive`, `migrateArchive`, `ownedTransport`, `participantConformance`, `planRestoreBindings`, `providerServeOptions`, `providerServeValues`, `publishIncremental`, `readJsonOption`, `rebaseArchiveNamespace`, `reconcileOperation`, `rehearseFleet`, `renderConnections`, `replayFleetTrace`, `resolveServeControls`, `resolveServeIdBase`, `resolveServeSettings`, `runCli`, `s3ConditionalStore`, `s3Repository`, `serve`, `serveCommand`, `startFleet`, `validateArchive`, `validateFleetConfig`, `withFleetRun`, `writeConnections`.

`mockingbird.yaml` declarations: `parseDeclaration`, `checkDeclaration`, `DeclarationError`, `isDeclaration`, `declaredFleets`, `localFleetConfig`, `DURABILITY_MODES`, `ACCESS_MODES`, `CLOUD_SERVICE_KEYS`.

## Client transport and private settings

`FleetClient` rejects every HTTP redirect before a follow-up, including same-origin redirects.
Custom `fetch` adapters must honor `redirect: 'manual'` and the supplied abort signal; adapters
that follow redirects internally cannot enforce the credential boundary. Redirect errors expose
only status/code, never Location. Proxy errors preserve HTTP status as `FleetClientError`; error
diagnostics keep bounded machine `type`/`code` identifiers and omit raw bodies, messages and excerpts.
Successful malformed JSON yields `FleetClientResponseError` with `code: 'invalid_json'`; empty
successful responses return `undefined`. Requests never automatically retry mutations.

Decoded responses default to a 64 MiB byte limit. `maxResponseBytes` on the client or `request`
sets an explicit limit, including archive calls. Both advertised length and streamed chunk totals
are checked; excess cancels the body with `code: 'response_too_large'`. The request deadline and
caller abort signal apply together through decoding.

`renderConnections` accepts `{service, field?, fallback?}` mappings. Existing `{service}` entries
still return the complete URL. Fields are `url`, `hostname`, `port`, `username`, `password`,
`pathname` and `database` (path without its leading slash). IPv6 hostnames omit URL brackets;
credentials and paths are percent-decoded. Ports use the explicit URL port; no service defaults
are guessed. Missing components reject unless an explicit string fallback is configured, including
an empty string. Missing protocol namespace URLs, missing services, malformed URLs and unknown
fields reject the whole render operation. The HTTP namespace path template remains available to
construct HTTP namespace URLs. Only the private manifest supplies credentials. `writeConnections`
keeps atomic 0600 JSON/dotenv output; never publish private output as discovery or diagnostics.

## Application archive compatibility

Configure `startFleet(..., {archiveCompatibility: {tags: {schema: 'v3', seed: 'baseline-a'}}})` to
include application tags in each archive's SHA-256 protected metadata and require the same exact
tag map before restoring any namespace or whole environment. This check also applies to repository
recovery and `rehearseFleet` (pass the same policy). Participant codec migrations remain separate;
package semver never implies application schema compatibility.

An untagged legacy archive rejects when a policy is present unless `missing: 'allow'` explicitly
approves legacy input. Without a policy, tagged and untagged archives remain supported. Tags are
caller-owned non-secret values: at most 32 entries, keys of 1–64 ASCII identifier characters and
values of 1–256 characters without control characters. Do not put credentials in tags.

`assertArchiveCompatibility` checks offline archives. The optional third policy argument to
`archiveCompatibility(input, registry, policy)` adds the same application check to codec planning. `migrateApplicationArchive` requires an
explicit source policy, destination tags and a registered transform callback, operates on a clone,
and seals and verifies a new archive; callers can use `migrateAndVerify`/repository publication
for rehearsal and publication. The source remains immutable. No migration runs implicitly during
restore, and a mismatch never triggers a fresh reset. The checksum detects corruption; use archive
protection for authenticity/confidentiality against an adversary able to replace an entire archive.

## Verification

`packed.consumer.test.ts` packs this package and selected Postgres, Redis, Cognito and SQLite
artifacts, installs them outside the monorepo, then uses Node to start, discover, namespace,
export and import that fleet. It asserts Stripe and private helper packages are absent. The
neutral CLI is also exercised from outside the consumer project and resolves installed services
from its consumer root. Run `bunx turbo run test --filter=@crvouga/mockingbird-fleet` in a checkout.
