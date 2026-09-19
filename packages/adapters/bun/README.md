# @crvouga/mockingbird-adapter-bun

> **Internal package — not published to npm.** Mockingbird publishes only its mock services (`@crvouga/mockingbird-service-*`), which bundle this code. It is documented here for contributors to this repo.

Serve any Mockingbird `FetchAPI` (a provider mock such as `StripeAPI`, or your own) as a real HTTP
server with `Bun.serve`. Use it on Bun when the code under test needs a URL rather than an injected
`fetch`. On Node, use `@crvouga/mockingbird-adapter-node` instead.

## Install

```bash
npm install @crvouga/mockingbird-adapter-bun
```

Bun >=1.2 only: the runtime code calls the global `Bun.serve`. ESM only.

The shipped `.d.ts` references `Bun` types, so TypeScript projects also need `@types/bun` (declared
as an optional peer dependency) and `"types": ["bun"]` if your tsconfig restricts `types`:

```bash
npm install -D @types/bun
```

## Usage

```ts
import { serve } from "@crvouga/mockingbird-adapter-bun"
import type { FetchAPI } from "@crvouga/mockingbird-core"

// Any FetchAPI works, e.g. `new StripeAPI()` from @crvouga/mockingbird-service-stripe.
const api: FetchAPI = {
  fetch: async (request) => Response.json({ method: request.method, url: request.url }),
}

// Port defaults to 0: the OS picks a free port. `serve` is synchronous.
const server = serve(api, { hostname: "127.0.0.1" })
const baseUrl = `http://127.0.0.1:${server.port}`

const response = await fetch(`${baseUrl}/v1/customers`)
console.log(await response.json())

server.stop() // e.g. in afterAll
```

## API

| Export | Signature | Description |
| --- | --- | --- |
| `serve` | `(api: FetchAPI, options?: BunServeOptions) => BunAdapterServer` | Start `Bun.serve` with `fetch: (request) => api.fetch(request)`. |

Types:

- `BunServeOptions`: `{ port?: number; hostname?: string }`. `port` defaults to `0` (ephemeral; read
  it from `server.port`); `hostname` is only passed when set.
- `BunAdapterServer`: `ReturnType<typeof Bun.serve>`, the Bun `Server` (`port`, `url`, `stop()`).

Requests and responses pass through unchanged (Bun is Fetch-native), so streaming bodies work.

## Related

- `@crvouga/mockingbird-core`: the `FetchAPI` contract.
- `@crvouga/mockingbird-adapter-node`: the same adapter for `node:http`.

Part of [mockingbird](https://github.com/crvouga/mockingbird).
