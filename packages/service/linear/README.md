# @crvouga/mockingbird-service-linear

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

GraphQL, OAuth, issues, teams, users, workflow states, comments, labels, projects, cycles, webhooks, agents, inspector. Runs through Mockingbird's portable Fetch runtime with SQLite persistence, namespaces, checkpoints, faults and admin controls.

## Install

```sh
npm install @crvouga/mockingbird-service-linear
```

## Usage

```ts
import { LinearClient } from "@linear/sdk"
import { createServer } from "@crvouga/mockingbird-service-linear/server"

// Test setup: the emulator, seeded with one synthetic team.
const team = { id: "0f0e8c1a-6f0b-4a53-9a43-3c7f0f1f2a10", key: "OPS", name: "Operations" }
const server = await createServer({ fixtures: { teams: [team] } })

// The app's own Linear client. Only its API URL changes.
const linear = new LinearClient({ apiKey: "lin_api_fixture", apiUrl: `${server.url}/graphql` })
const viewer = await linear.viewer
const created = await linear.createIssue({ teamId: team.id, title: "Fixture issue", assigneeId: viewer.id })
console.log(created.success) // true
if (created.issueId) await linear.createComment({ issueId: created.issueId, body: "Reproduced locally." })
await server.close()
```

The GraphQL schema is a subset of Linear's. With `@linear/sdk` 97, `viewer` and the create and
update mutations work; model reads that select fields outside the subset (`teams()`, `issues()`,
`issue(id)`) are rejected, so query those through `linear.client.rawRequest` with the fields you need.

## API

- `LinearAPI`: portable provider instance; accepts SQLite, namespace, clock, fixtures and baseUrl.
- `createRuntime`: shared runtime, including native namespace and checkpoint controls.
- `LINEAR_NAMESPACE`: default storage namespace.
- `document`, `operationIds`, `supportedOperationIds`: registered provider route inventory.
- `createServer`, `DEFAULT_PORT`, `serveTarget` from `/server`: loopback listener and CLI configuration.

`fixtures` accepts synthetic provider seed records. `reset()` restores defaults. Emulate 0.12.1 is a test oracle only, never a runtime dependency. Vendor handlers ported under Apache-2.0 retain their license and attribution; see LICENSE_EMULATE and THIRD_PARTY_NOTICES.md.

See [SUPPORT.md](SUPPORT.md) for coverage and limits and [API_EVIDENCE.md](API_EVIDENCE.md) for validation status.
