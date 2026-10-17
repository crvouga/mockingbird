# @crvouga/mockingbird-fleet

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Vendor-neutral Node.js fleet management. Requires Node.js 22 or newer. Install
`@crvouga/mockingbird-fleet` and the emulator packages your application uses; Stripe is optional.
The private `@crvouga/mockingbird-adapter-node` implementation is bundled, never installed separately.
Existing `@crvouga/mockingbird-service-stripe/fleet` imports remain supported with the same API.

## Install

```sh
npm install @crvouga/mockingbird-fleet @crvouga/mockingbird-service-postgres @crvouga/mockingbird-service-redis @crvouga/mockingbird-service-cognito
```

## Usage

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

```sh
mockingbird-fleet serve --config mockingbird.json --ready-json
mockingbird-fleet fleet doctor --config mockingbird.json --json
```

The package exports typed lifecycle, client, archives, repositories, discovery, migrations,
participants, connection rendering and extension contracts. Public discovery omits credentials;
write connection files to private paths. Public ingress support is provider-specific.

## API

`FleetClient`, `FleetClientError`, `FleetClientResponseError`, `FleetInstrumentation`, `FleetObservations`, `FleetRunError`, `NamespacePool`, `RepositoryWriter`, `advertisedHttpBase`, `archiveCompatibility`, `archiveProtector`, `archiveReachability`, `assertArchiveCompatibility`, `assertFleetConfig`, `compactArchive`, `composeFleetSchema`, `createFleetIngress`, `createInstalledServiceLoader`, `diffArchives`, `doctorFleet`, `fileParticipant`, `filesystemConditionalStore`, `filesystemOperationJournal`, `filesystemRepository`, `fleetCommands`, `fleetConfigSchema`, `incrementalArchive`, `ingressSupport`, `inspectArchive`, `launchFleet`, `listen`, `materializeArchive`, `migrateAndVerify`, `migrateApplicationArchive`, `migrateArchive`, `ownedTransport`, `participantConformance`, `planRestoreBindings`, `providerServeOptions`, `providerServeValues`, `publishIncremental`, `rebaseArchiveNamespace`, `reconcileOperation`, `rehearseFleet`, `renderConnections`, `replayFleetTrace`, `resolveServeControls`, `runCli`, `s3ConditionalStore`, `s3Repository`, `serve`, `serveCommand`, `startFleet`, `validateArchive`, `validateFleetConfig`, `withFleetRun`, `writeConnections`.

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
