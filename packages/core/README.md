# @crvouga/mockingbird-core

> **Internal package — not published to npm.** Mockingbird publishes only its emulator services (`@crvouga/mockingbird-service-*`), which bundle this code. It is documented here for contributors to this repo.

The one contract shared by every Mockingbird package: `FetchAPI`, anything that answers a Fetch
`Request` with a `Response`. Every emulator service implements it and every runtime adapter consumes it.
You rarely install this directly. Most users want a provider emulator such as
`@crvouga/mockingbird-service-stripe`; depend on this package
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
  Timeline,
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
console.log(await (await wrapped.fetch(new Request("https://emulator.local/"))).text()) // "ok"

// One persistent checkpoint DAG works for any immutable/COW state representation.
const history = new Timeline<{ count: number }>({ maxCheckpoints: 100 })
const root = history.commit({ count: 0 })
history.fork("experiment", { from: root.id })
history.commit({ count: 1 }, { branch: "experiment" })
```

Pass an emulator straight to your code under test as its `fetch`, e.g. `fetch: (input, init) =>
api.fetch(new Request(input, init))`, or serve it over HTTP with an adapter (see Related).

## API

| Export | Signature | Description |
| --- | --- | --- |
| `toFetchHandler` | `(api: FetchAPI) => FetchHandler` | Turn a `FetchAPI` object into a bare handler function. |
| `fromFetchHandler` | `(handler: FetchHandler) => FetchAPI` | Wrap a bare handler as `{ fetch: handler }`. |
| `Timeline<T>` | `new Timeline({ now?, maxCheckpoints?, id? })` | Deterministic, storage-agnostic checkpoint DAG with `commit`, `fork`, `checkout`, branch heads and bounded GC. Values are retained by reference so COW snapshots stay O(1). |
| `openDurable<T>` | `({ backend, key, codec, pageSize? }) => Promise<Durable<T>>` | Hydrate any emulator through its binary codec. A handle provides `value`, `flush`, serialized `write`, and save-before-close `close`. |
| `withDurability` | `(api: FetchAPI, durable) => FetchAPI` | Serialize requests and acknowledge responses only after their storage commit. Inject the handle's value into the service's existing storage port. |
| `IndexedDBDurabilityBackend` | `new ({ name?, indexedDB?, durability? })` | Atomic binary page writes with revision checks. Default durability hint is `strict`; no browser globals are accessed until construction. |
| `LocalStorageDurabilityBackend` | `new ({ storage?, prefix?, locks? })` | Small-image fallback. Whole-image base64 writes; Web Locks coordinate tabs when available. Otherwise use one writer per key. |
| `MemoryDurabilityBackend` | `new ()` | Ephemeral reference implementation of the same port. |
| `DurabilityConflictError` | `Error` | Rejects a stale writer instead of overwriting another writer's image. |
| `applyDurablePatch`, `validateDurablePatch`, `validateDurableCommit` | Binary patch helpers | Shared validation/application utilities for custom adapters. |

`DurabilityBackend` is the storage port: `load(key)` returns an owned `DurableImage` (revision,
page size and bytes), and `commit(key, expectedRevision, patch)` must atomically check the revision,
replace changed pages, truncate removed pages and advance the revision. Failed commits must leave
the prior image intact. Inputs must not be mutated. `DurabilityCodec<T>` owns emulator creation,
binary encoding/decoding and optional close. `DurableOptions<T>` injects both ports.

No synchronous mutation becomes durable until an awaited `flush`, `write`, or `close` succeeds.
Batch related SQL in the database's existing transaction API for rollback, then flush once.
Avoid direct mutations during an outstanding save. Saves encode and compare a full image, then
send only changed pages; encoding remains O(image size). An unchanged image skips the storage
write. Persisted state remains subject to browser eviction and quotas. Injected adapters stay
caller-owned; database convenience factories release their own default IndexedDB connection on
close. The portable database packages re-export these public durability APIs for consumers.

`Timeline` is the only history and branching primitive prescribed for Mockingbird state. Storage
engines may expose immutable COW payloads named `Snapshot` for compatibility and serialization,
but branch heads, retention, checkout, and garbage collection belong to `Timeline`. Its hot commit
path is O(1) amortized: an ordered unpinned-node set avoids rescanning history or branch heads.

Types:

- `FetchAPI`: `interface { fetch(request: Request): Promise<Response> }`. The contract.
- `FetchHandler`: `(request: Request) => Promise<Response>`.

`toFetchHandler` returns a closure (`(request) => api.fetch(request)`), so class instances keep
their `this` binding.

## Related

- `@crvouga/mockingbird-adapter-node`: serve a `FetchAPI` over `node:http`.
- `@crvouga/mockingbird-adapter-bun`: serve a `FetchAPI` with `Bun.serve`.
- `@crvouga/mockingbird-service`: build a `FetchAPI` from an OpenAPI document.

Part of [mockingbird](https://github.com/crvouga/mockingbird).
