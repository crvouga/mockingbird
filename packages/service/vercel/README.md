# @crvouga/mockingbird-service-vercel

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

projects, deployments, domains, env vars, users, teams, file uploads, protection bypass, blob storage. Runs through Mockingbird's portable Fetch runtime with SQLite persistence, namespaces, checkpoints, faults and admin controls.

## Install

```sh
npm install @crvouga/mockingbird-service-vercel
```

## Usage

```ts
import { Vercel } from "@vercel/sdk"
import { HTTPClient } from "@vercel/sdk/lib/http.js"
import { createRuntime } from "@crvouga/mockingbird-service-vercel"

// Test setup: the emulator, seeded with one synthetic project.
const emulator = createRuntime({ fixtures: { projects: [{ name: "fixture-app", framework: "nextjs" }] } })

// The app's own Vercel client. Only its HTTP client changes: requests reach the
// emulator in this process instead of api.vercel.com.
const vercel = new Vercel({
  bearerToken: "fixture-token",
  httpClient: new HTTPClient({
    fetcher: (input: RequestInfo | URL, init?: RequestInit) => emulator.fetch(new Request(input, init)),
  }),
})
const domain = await vercel.projects.addProjectDomain({
  idOrName: "fixture-app",
  requestBody: { name: "fixture.example.com" },
})
console.log(domain.verified) // false
const { domains } = await vercel.projects.getProjectDomains({ idOrName: "fixture-app" })
console.log(domains.map((each) => each.name)) // ["fixture.example.com"]
```

`@vercel/sdk` validates every response against Vercel's full schema. With 1.28 the domain,
user, team and deployment-list calls pass; `createProject`, `getProjects`, `filterProjectEnvs`,
`createProjectEnv` and `createDeployment` reach the emulator but fail the SDK's response validation.

## API

- `VercelAPI`: portable provider instance; accepts SQLite, namespace, clock, fixtures and baseUrl.
- `createRuntime`: shared runtime, including native namespace and checkpoint controls.
- `VERCEL_NAMESPACE`: default storage namespace.
- `document`, `operationIds`, `supportedOperationIds`: registered provider route inventory.
- `createServer`, `DEFAULT_PORT`, `serveTarget` from `/server`: loopback listener and CLI configuration.

`fixtures` accepts synthetic provider seed records. `reset()` restores defaults. Emulate 0.12.1 is a test oracle only, never a runtime dependency. Vendor handlers ported under Apache-2.0 retain their license and attribution; see LICENSE_EMULATE and THIRD_PARTY_NOTICES.md.

See [SUPPORT.md](SUPPORT.md) for coverage and limits and [API_EVIDENCE.md](API_EVIDENCE.md) for validation status.
