# Namespaces

A namespace is an isolation key. Each key has its own records, clock, random streams, faults, latency, journal, metrics and snapshots, so parallel test workers share one emulator without seeing each other.

<!-- search: isolation isolate key tenant multi-tenant parallel workers namespace credential state isolation by key -->

## Interface

| Carrier | How |
| --- | --- |
| Request header | `x-mockingbird-namespace: <key>` |
| Base URL | `<origin>/__admin/ns/<key>/…`, for SDKs that only take a base URL |
| Vendor credential | `PUT /__admin/credentials` maps a credential to a key, for SDKs that take neither |
| Admin API | `?namespace=<key>` or the header on any admin route · `GET /__admin/namespaces` · `DELETE /__admin/namespaces/<key>` |
| At boot | `adminControls.namespaces` · `adminControls.credentials` |
| In process | `runtime.instance(key)` · `runtime.namespaces()` · `runtime.dropNamespace(key)` · `runtime.credentials` |
| Admin page | The header **Namespace** select. There is no Namespaces screen |

A key matches `[A-Za-z0-9_.-]{1,64}`. A request that names none uses `default`, which is a key like any other.

## Admin page

Every screen shares the header **Namespace** select. It lists keys that already hold state and switches the page to that key. It does not create a key: a key appears after something writes to it. Deleting a key is `DELETE /__admin/namespaces/<key>`, from the [Routes](REFERENCE.md#admin-page) screen or the API.

## Choose the namespace of a request

**By header.** Any client that can set a header:

```bash
curl localhost:8787/v1/customers -H 'x-mockingbird-namespace: worker-3' \
  -H 'authorization: Bearer sk_test_mockingbird'
```

**By base URL.** Put the key in the path and hand that to the SDK as its base URL. The prefix is removed before the request reaches the emulator:

```bash
curl localhost:8787/__admin/ns/worker-3/v1/customers \
  -H 'authorization: Bearer sk_test_mockingbird'
```

**By credential.** Map a vendor credential to a key once; every request that carries the credential then lands in that namespace:

```bash
curl -X PUT localhost:8787/__admin/credentials \
  -d '{"credentials": {"sk_test_a": "worker-3"}}'
```

```json
{ "mapped": 1 }
```

When more than one is present, the header wins over the base URL, and both win over a credential.

## Admin API

Every admin route acts on one namespace: the one named by `?namespace=<key>`, else by the `x-mockingbird-namespace` header, else `default`.

### `GET /__admin/namespaces`

The keys in use.

```jsonc
{ "default": "default", "namespaces": ["default", "worker-3"] }
```

### `DELETE /__admin/namespaces/<key>`

[Reset](RESET.md) the namespace and forget it: its records, controls, snapshots, journal and clock are released. Use it to tear down a namespace a long-running emulator will not see again.

```bash
curl -X DELETE localhost:8787/__admin/namespaces/worker-3
```

```json
{ "status": "ok", "namespaces": [] }
```

### `PUT /__admin/credentials`

Map vendor credentials to namespaces. The body takes any of these shapes:

| Body | Maps |
| --- | --- |
| `{"credentials": {"<credential>": "<key>"}}` | Each credential to its key |
| `[{"credential": "<credential>", "namespace": "<key>"}]` | The same, as a list |
| `{"credentials": ["<credential>"]}` | Each credential to the calling namespace |

Answers `{"mapped": <count>}`.

### `GET /__admin/credentials`

The mappings, with each credential masked.

```bash
curl -X PUT localhost:8787/__admin/credentials -d '{"credentials": {"sk_test_a": "worker-3"}}'
curl localhost:8787/__admin/credentials
```

```json
{ "credentials": [{ "credential": "sk_tes…_a", "namespace": "worker-3" }] }
```

### `DELETE /__admin/credentials`

Remove one mapping with `?credential=<credential>`, or all of them without it. Answers `{"status": "ok"}`.

## At boot

`namespaces` gives a key its own controls, replacing the shared ones key by key. `credentials` maps credentials before the first request.

```json
{
  "latency": "5ms",
  "credentials": { "sk_test_tenant_a": "tenant-a" },
  "namespaces": {
    "tenant-a": { "latency": "50ms", "faults": [{ "status": 429 }] }
  }
}
```

See [Boot configuration](BOOT.md) for where this document goes.

## In process

```ts
runtime.instance("worker-3")        // the emulator instance behind a key, created on first use
runtime.namespaces()                // ["default", "worker-3"]
await runtime.dropNamespace("worker-3")
runtime.credentials.set("sk_test_a", "worker-3")
runtime.headers({ namespace: "worker-3" }) // { "x-mockingbird-namespace": "worker-3" }
```

## What a namespace owns

| Per namespace | Shared by every namespace |
| --- | --- |
| Records and generated ids | Fault rules added with `"namespace": "*"` |
| Clock offset and freeze | The base clock every namespace follows |
| Seed and random streams | Credential mappings |
| Fault rules, latency, virtual time | |
| Snapshots, checkpoints, branches | |
| Journal and metrics | |

- Ids the admin API assigns (`fault_1`, `snap_1`) count per namespace, so a worker gets the same ids whatever the others are doing.
- Every namespace starts from the same seed, so a test gives the same result in `worker-1` as in `worker-7`.
- Nothing one namespace does changes what another returns. A property test runs random requests in other namespaces between a namespace's own and compares every byte.

## Errors

| Status | When |
| --- | --- |
| `400` | The key does not match `[A-Za-z0-9_.-]{1,64}` |

## Related

- [Reset](RESET.md) returns one namespace, or all of them, to boot.
- [Seed and determinism](SEED_AND_DETERMINISM.md) for what isolation guarantees.
