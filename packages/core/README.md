# @crvouga/mockingbird-core

The one contract shared by every Mockingbird package: `FetchAPI`, anything that answers a Fetch
`Request` with a `Response`. Every mock service implements it and every runtime adapter consumes it.
You rarely install this directly. Most users want a provider mock such as
`@crvouga/mockingbird-service-stripe`, or the `@crvouga/mockingbird` facade; depend on this package
only when you write your own `FetchAPI` or a function that accepts one.

## Install

```bash
npm install @crvouga/mockingbird-core
```

ESM only. Portable: no Node- or Bun-only APIs, so it runs on Node >=22, Bun >=1.2, Deno, workerd and
browsers. It has no runtime dependencies.

## Usage

```ts
import {
  type FetchAPI,
  type FetchHandler,
  fromFetchHandler,
  toFetchHandler,
} from "@crvouga/mockingbird-core"

// Any object with `fetch(request) => Promise<Response>` is a FetchAPI.
const api: FetchAPI = {
  fetch: async (request) => Response.json({ path: new URL(request.url).pathname }),
}

// A bare function works where `Bun.serve({ fetch })`, workerd or Deno expect a handler.
const handler: FetchHandler = toFetchHandler(api)
const response = await handler(new Request("https://mock.local/v1/ping"))
console.log(await response.json()) // { path: "/v1/ping" }

// And back again: wrap a plain handler so it can go wherever a FetchAPI is expected.
const wrapped: FetchAPI = fromFetchHandler(async () => new Response("ok"))
console.log(await (await wrapped.fetch(new Request("https://mock.local/"))).text()) // "ok"
```

Pass a mock straight to your code under test as its `fetch`, e.g. `fetch: (input, init) =>
api.fetch(new Request(input, init))`, or serve it over HTTP with an adapter (see Related).

## API

| Export | Signature | Description |
| --- | --- | --- |
| `toFetchHandler` | `(api: FetchAPI) => FetchHandler` | Turn a `FetchAPI` object into a bare handler function. |
| `fromFetchHandler` | `(handler: FetchHandler) => FetchAPI` | Wrap a bare handler as `{ fetch: handler }`. |

Types:

- `FetchAPI`: `interface { fetch(request: Request): Promise<Response> }`. The contract.
- `FetchHandler`: `(request: Request) => Promise<Response>`.

`toFetchHandler` returns a closure (`(request) => api.fetch(request)`), so class instances keep
their `this` binding.

## Related

- `@crvouga/mockingbird-adapter-node`: serve a `FetchAPI` over `node:http`.
- `@crvouga/mockingbird-adapter-bun`: serve a `FetchAPI` with `Bun.serve`.
- `@crvouga/mockingbird-service`: build a `FetchAPI` from an OpenAPI document.

Part of [mockingbird](https://github.com/crvouga/mockingbird) — agent integration guide: [`@crvouga/mockingbird`](https://github.com/crvouga/mockingbird/tree/main/packages/facade#readme).
