# @crvouga/mockingbird-adapter-node

> **Internal package — not published to npm.** Mockingbird publishes only its emulator services (`@crvouga/mockingbird-service-*`), which bundle this code. It is documented here for contributors to this repo.

Serve any Mockingbird `FetchAPI` (a provider emulator such as `StripeAPI`, or your own) as a real HTTP
server over `node:http`. Use it when the code under test needs a URL (a subprocess, a browser, an
SDK you cannot hand a `fetch`). If you can inject `fetch`, call the emulator's `fetch` directly instead;
on Bun, `@crvouga/mockingbird-adapter-bun` is lighter.

## Supported consumer entry points

Install a published service and use its bundled CLI. Never install this private workspace package.

```bash
npm install @crvouga/mockingbird-service-stripe
npx mockingbird-stripe serve --config mockingbird.json --ready-file ready.json
```

The supported management client and contributor-independent harness APIs are exported from
`@crvouga/mockingbird-service-stripe/fleet`. The CLI can supervise other installed services;
see [Fleets](../../../docs/FLEETS.md).

Requires Node >=22 (also runs on Bun, which implements `node:http`). ESM only.

## Contributor-only workspace usage

The following internal imports are for this repository's contributors, after `bun run setup`.
Consumer programs should use the service's public `/fleet` entry point above.

```ts
import type { AddressInfo } from "node:net"
import { serve } from "@crvouga/mockingbird-adapter-node"
import type { FetchAPI } from "@crvouga/mockingbird-core"

// Any FetchAPI works, e.g. `new StripeAPI()` from @crvouga/mockingbird-service-stripe.
const api: FetchAPI = {
  fetch: async (request) =>
    Response.json({ method: request.method, url: request.url, body: await request.text() }),
}

// Port defaults to 0: the OS picks a free port.
const server = await serve(api, { host: "127.0.0.1" })
const { port } = server.address() as AddressInfo
const baseUrl = `http://127.0.0.1:${port}`

const response = await fetch(`${baseUrl}/v1/customers`, { method: "POST", body: "email=a@b.c" })
console.log(await response.json())

// Tear down (e.g. in afterAll). closeAllConnections drops keep-alive sockets so the process exits.
server.close()
server.closeAllConnections()
```

## API

| Export | Signature | Description |
| --- | --- | --- |
| `serve` | `(api: FetchAPI, options?: NodeServeOptions) => Promise<http.Server>` | Start listening; resolves once bound, rejects on listen errors (e.g. `EADDRINUSE`). |

Types:

- `NodeServeOptions`: `{ port?: number; host?: string; maxBodyBytes?: number; requestTimeoutMs?: number }`. `port` defaults to `0` (ephemeral; read it
  from `server.address()`); `host` is passed to `server.listen` (Node's default when omitted).

Behavior:

- Incoming bodies stream into Fetch `Request` handlers, bounded incrementally at 16 MiB / 30 seconds
  by default. Oversized/chunked uploads return 413; stalled uploads return 408. Bodies are forwarded
  for methods other than GET/HEAD. URL/Request construction and aborted uploads are caught.
- Response bodies stream chunk by chunk with backpressure; repeated `Set-Cookie` values remain
  separate headers. Client disconnects cancel the response reader and release backpressure waits.
- `MOCKINGBIRD_DROP` errors destroy the socket. Other fetch failures become structured 500
  `mockingbird_internal` responses. Mid-stream failures close the connection after sent chunks.
- Fleet controls track open response bodies, not just the time until headers. Configure larger,
  bounded body limits directly on `serve` for large archive imports. JSON control handlers still
  parse a bounded complete document; this is not an unbounded streaming JSON parser.

## Related

- `@crvouga/mockingbird-core`: the `FetchAPI` contract.
- `@crvouga/mockingbird-adapter-bun`: the same adapter for `Bun.serve`.

Part of [mockingbird](https://github.com/crvouga/mockingbird).
