# @crvouga/mockingbird-adapter-node

> **Internal package — not published to npm.** Mockingbird publishes only its mock services (`@crvouga/mockingbird-service-*`), which bundle this code. It is documented here for contributors to this repo.

Serve any Mockingbird `FetchAPI` (a provider mock such as `StripeAPI`, or your own) as a real HTTP
server over `node:http`. Use it when the code under test needs a URL (a subprocess, a browser, an
SDK you cannot hand a `fetch`). If you can inject `fetch`, call the mock's `fetch` directly instead;
on Bun, `@crvouga/mockingbird-adapter-bun` is lighter.

## Install

```bash
npm install @crvouga/mockingbird-adapter-node
```

Requires Node >=22 (also runs on Bun, which implements `node:http`). ESM only.

## Usage

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

- `NodeServeOptions`: `{ port?: number; host?: string }`. `port` defaults to `0` (ephemeral; read it
  from `server.address()`); `host` is passed to `server.listen` (Node's default when omitted).

Behavior:

- Each incoming request is buffered and converted to a Fetch `Request`. The URL is built from the
  `Host` header; leading repeated slashes in the path collapse to one.
- The body is forwarded only for methods other than `GET`/`HEAD`, and only when non-empty.
- The `Response` status, headers and body are written back in full (no streaming). Repeated
  `Set-Cookie` headers are preserved, one header line per cookie.
- Errors thrown by `api.fetch` are not caught by the adapter; return error responses from your
  `FetchAPI` instead.

## Related

- `@crvouga/mockingbird-core`: the `FetchAPI` contract.
- `@crvouga/mockingbird-adapter-bun`: the same adapter for `Bun.serve`.

Part of [mockingbird](https://github.com/crvouga/mockingbird).
