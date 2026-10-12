# @crvouga/mockingbird-service-mongoatlas

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Atlas Admin API v2 (projects, clusters, database users, databases, collections), Atlas Data API v1 (findOne, find, insertOne, insertMany, updateOne, updateMany, deleteOne, deleteMany, aggregate). Runs through Mockingbird's portable Fetch runtime with SQLite persistence, namespaces, checkpoints, faults and admin controls.

## Install

```sh
npm install @crvouga/mockingbird-service-mongoatlas
```

## Usage

```ts
import { createServer } from "@crvouga/mockingbird-service-mongoatlas/server"

const server = await createServer({ seed: 1 })

// Atlas publishes no JavaScript SDK for the Admin API, so the application calls it over HTTP.
// Only the base URL changes: the emulator instead of https://cloud.mongodb.com.
const atlas = (path: string) =>
  fetch(`${server.url}/api/atlas/v2${path}`, {
    headers: { accept: "application/vnd.atlas.2025-03-12+json", authorization: "Bearer mock_atlas_token" },
  })
const projects = (await (await atlas("/groups")).json()) as { results: { id: string; name: string }[] }
const clusters = await atlas(`/groups/${projects.results[0]?.id}/clusters`)
console.log(projects.results[0]?.name, clusters.status) // Project0 200

await server.close()
```

## API

- `MongoAtlasAPI`: portable provider instance; accepts SQLite, namespace, clock, fixtures and baseUrl.
- `createRuntime`: shared runtime, including native namespace and checkpoint controls.
- `MONGOATLAS_NAMESPACE`: default storage namespace.
- `document`, `operationIds`, `supportedOperationIds`: registered provider route inventory.
- `createServer`, `DEFAULT_PORT`, `serveTarget` from `/server`: loopback listener and CLI configuration.

`fixtures` accepts synthetic provider seed records. `reset()` restores defaults. Emulate 0.12.1 is a test oracle only, never a runtime dependency. Vendor handlers ported under Apache-2.0 retain their license and attribution; see LICENSE_EMULATE and THIRD_PARTY_NOTICES.md.

See [SUPPORT.md](SUPPORT.md) for coverage and limits and [API_EVIDENCE.md](API_EVIDENCE.md) for validation status.
