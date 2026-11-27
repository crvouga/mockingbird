# @crvouga/mockingbird-runtime

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

The runtime every Mockingbird emulator service is built on: the router, the `/__admin` API and
page, snapshots, faults, the clock, and the HTTP and OpenAPI helpers. Each
`@crvouga/mockingbird-service-*` package depends on it at the same version, so an application
that installs or bundles several emulators carries one copy of it, not one per service. The
admin page's browser client (`dist/admin-ui.js`) is loaded only on the first `/__admin/ui`
request.

Emulators install it automatically. Preview applications can also import the supported system
harness from `@crvouga/mockingbird-runtime/ui`.

## Install

```sh
npm install -D @crvouga/mockingbird-runtime
```

Install the runtime as a regular dependency (`npm install @crvouga/mockingbird-runtime`) in a package that implements an emulator. Applications using emulators only in tests can use dev dependencies.

## Usage

```ts
import { createRuntime } from "@crvouga/mockingbird-service-sqs"

const sqs = createRuntime()
const response = await sqs.fetch(new Request("http://sqs.local/__admin/health"))
```

## Author a custom HTTP service

Use `@crvouga/mockingbird-runtime/authoring` in an application workspace or an independently
published package. The example below runs directly against Fetch.

```ts
import { defineHttpService } from "@crvouga/mockingbird-runtime/authoring"

const { createRuntime, serveTarget } = defineHttpService({
  name: "rates",
  version: "1.0.0",
  document: {
    openapi: "3.1.0",
    info: { title: "Sample rates", version: "1" },
    paths: { "/rate": { get: {
      operationId: "getRate", responses: { "200": { description: "Current rate" } },
    } } },
  },
  handlers: () => ({ getRate: () => Response.json({ cents: 125 }) }),
})
const response = await createRuntime().fetch(new Request("https://rates.example/rate"))
console.log(await response.json()) // { cents: 125 }
```

Export `createRuntime` from your package entry and `serveTarget` from its `./server` entry.
Both can be re-exports from the same module. The runtime adds the standard admin API, namespaces,
clock, faults, request journal, reset and snapshots. The default port is ephemeral. For a stateful
service, use the [working job queue](https://github.com/crvouga/mockingbird/blob/main/packages/runtime/examples/jobs.ts)
and the [authoring and fleet guide](https://github.com/crvouga/mockingbird/blob/main/docs/AUTHORING_A_SERVICE.md#custom-http-services-in-your-own-project).

## API

- The supported `/authoring` entry exports `defineHttpService`, `Collection`, `IdSequence`, `bodyIssues`, `defineOperations`, and `jsonResponse`. Its factory and target types can also be used in package declarations.
- `RUNTIME_SUBPATHS`: the subpaths this package exports (`core`, `service`, `sqlite`, …), each
  re-exporting the Mockingbird helper of that name.

The `ui` entry is a supported public preview API: `mountSystemHarness`, `SystemHarness`,
`SystemSurface`, `CSS_RESET` and `scopeReset`. The `preview/*` entries below are also supported. Other helper subpaths are internal to emulator
services; depend on a service's own exports for those capabilities.

To leave the admin page's client out of a single-file application bundle, mark it external
(`esbuild --external:./admin-ui.js`); `/__admin/ui` then answers 503 and everything else works.


## Canonical preview package and compatibility

Worker hosting, the MessagePort bridge, artifact loading and the Node HTTP adapter are implemented
once in [`@crvouga/mockingbird-preview`](../adapters/preview/README.md). The existing runtime
`preview/*` exports remain supported compatibility adapters; they delegate to that package and
preserve their public signatures, first generation `1`, promise-shaped `ready`, explicit cookie
headers and error messages. New consumers can use the canonical package directly for URL policies,
opaque errors by default, SharedWorker identities, bounded artifacts and static deployment helpers.

The artifact formats intentionally differ: legacy `{version: 1}` manifests identify decoded
JavaScript bytes, while canonical `{format: 1}` manifests identify the downloaded bytes and include
commit, size and encoding. One bounded loader understands both. Never reinterpret a legacy gzip
hash as a canonical packed-byte hash; generate a new manifest when migrating.

## System harness for application previews

```ts
import { mountSystemHarness, type SystemSurface } from "@crvouga/mockingbird-runtime/ui"

const surfaces: SystemSurface[] = [{
  id: "app",
  label: "Application",
  mount(element, signal) {
    element.textContent = "Application preview"
    // Mount your real application here; use signal for pending asynchronous work.
    return () => element.replaceChildren()
  },
}]
const root = document.createElement("div")
root.style.height = "100vh"
document.body.append(root)
const harness = mountSystemHarness(root, surfaces, { initial: "app", syncUrl: true })
await harness.show("system")
// On teardown: harness.destroy(); root.remove()
```

The System home and app switcher are built in. Surfaces mount lazily and stay mounted while
hidden. Async mounts show loading and retryable error states, receive a teardown signal, and
return their own cleanup function. Surface IDs must be unique; `system` is reserved. The returned
handle exposes `show(id)`, `active()` and `destroy()`. URL synchronization is opt-in for standalone
previews; omit it in embedded hosts.

The medical-testing example and its Storybook stories use this same shell. The preview subpaths below add worker hosting, streaming request bridges, artifacts and Node test access. Application configuration, seed data
and credential policies remain in the consuming project.


## Worker hosting and test access

These supported subpaths ship in this package; no unpublished adapter is required.

| Entry | Exports | Purpose |
| --- | --- | --- |
| `/preview/bridge` | `createPreviewClient`, `attachPreviewHost` | MessagePort Fetch bridge with streamed responses, cancellation and deadlines. |
| `/preview/host` | `createPreviewHost` | Shared app startup, readiness, reset generations and disposal. |
| `/preview/artifacts` | `loadPreviewArtifact`, `createPreviewWorker` | Versioned SHA-256 manifests, optional gzip and worker disposal. |
| `/preview/harness` | `startPreviewHarness` | Node-only HTTP endpoint backed by the same bridge Fetch function. |

```ts
import { createPreviewHost } from "@crvouga/mockingbird-runtime/preview/host"
import { createPreviewClient } from "@crvouga/mockingbird-runtime/preview/bridge"

const host = createPreviewHost(() => ({
  fetch: request => new Response(new URL(request.url).pathname),
  dispose() {},
}))
await host.ready
const channel = new MessageChannel()
const disconnect = host.connect(channel.port1)
const client = createPreviewClient(channel.port2, { timeoutMs: 30_000 })
console.log(await (await client.fetch("http://localhost:3000/example")).text())
client.dispose()
disconnect()
await host.dispose()
```

In a dedicated worker, receive a transferred MessageChannel port and call `host.connect(port)`.
In a SharedWorker, connect each port from its `connect` event to the same host. One disconnected
client leaves other clients running. Await `host.ready` for startup errors; `host.state()` reports
status and generation. `host.reset()` disposes the current application and runs the factory again.
The application owns its servers, routing, seeds and active work, and must close them in `dispose()`.

Requests buffer their bodies; responses transfer one chunk per pull. The deadline covers the
response body lifetime, including SSE. Dispose clients on worker errors and page teardown; an
unannounced worker death otherwise fails at the deadline. Host disposal errors pending responses.
Redirects are returned without following them. Cookies are explicit headers, with no inherited
browser cookie jar or automatic Set-Cookie persistence; keep per-session jars in application code.
Workers and the bridge run trusted code and are not security sandboxes.

Artifact manifests contain `version: 1`, `url`, `sha256` (lowercase hex of decoded JavaScript) and
optional `compression: "gzip"`. Serve compressed artifacts without HTTP Content-Encoding so they
are not decompressed twice. Blob workers require a bundled file without relative imports and CSP
permission for blob workers. Call the returned worker's `dispose()` to terminate and revoke it.

A Node host connected to the worker transport can call `startPreviewHarness(client.fetch,
{ origin: "http://localhost:3000" })`. This exposes the same running application to HTTP test
clients, with streamed responses, connection failure for post-header errors and no-store caching.
It does not launch Chromium or establish a cross-process browser connection for you.

The packed-consumer test installs local release tarballs into an empty npm project and runs the
public UI and worker entries in Chromium. Native Node/Bun compatibility, virtual sockets,
AsyncLocalStorage and framework certification belong to the separate browser-adapter work; these
helpers do not claim that arbitrary server applications run unchanged in a browser.
