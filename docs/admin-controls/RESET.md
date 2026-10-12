# Reset

Reset returns a namespace to exactly the state it booted in: records, ids, clock, seed, faults, latency, snapshots, journal and metrics. A reset namespace cannot be told apart from a new one, which is what makes a test independent of the tests before it.

<!-- search: reset clear wipe clean state start over teardown beforeEach state reset -->

## Interface

| Carrier | How |
| --- | --- |
| Admin API | `POST /__admin/reset` · `POST /__admin/reset?all=1` · `DELETE /__admin/controls` |
| Request header | `x-mockingbird-reset: true` |
| In process | `await runtime.reset(key?)` · `await runtime.reset("*")` |
| Admin page | **Overview** → Reset namespace |

## Admin page

**Overview** (`/__admin/ui#overview`) ends with **Reset namespace**. It asks for confirmation, then `POST /__admin/reset` for the namespace selected in the header. Other namespaces stay. Nothing on the page resets every namespace; that is `POST /__admin/reset?all=1`.

## Admin API

### `POST /__admin/reset`

Reset the calling namespace. No body.

```bash
curl -X POST localhost:8787/__admin/reset
```

```json
{ "status": "ok", "reset": ["default"] }
```

Reset another namespace with `?namespace=<key>` or the `x-mockingbird-namespace` header.

### `POST /__admin/reset?all=1`

Reset every namespace, the fault rules shared by all of them, and the base clock. `reset` lists the namespaces that were reset.

```bash
curl -X POST 'localhost:8787/__admin/reset?all=1'
```

```json
{ "status": "ok", "reset": [] }
```

### `DELETE /__admin/controls`

Return only the controls to boot: clock, seed, faults, latency and virtual time. Records, snapshots and the journal stay. Answers the namespace's [control document](CONTROL_DOCUMENT.md).

```bash
curl -X DELETE localhost:8787/__admin/controls
```

## Request header

`x-mockingbird-reset: true` resets the namespace before the request is handled, so a test's first request can start from a clean state without a separate call.

```bash
curl -X POST localhost:8787/v1/customers -H 'x-mockingbird-reset: true' \
  -H 'x-mockingbird-namespace: worker-3' -H 'authorization: Bearer sk_test_mockingbird'
```

It cannot be combined with `x-mockingbird-restore` or `x-mockingbird-at`: a reset discards the snapshots and history those name, so the request is refused with `400` and nothing is reset.

## In process

```ts
await runtime.reset()            // the default namespace
await runtime.reset("worker-3")  // one namespace
await runtime.reset("*")         // every namespace
```

## What a reset returns to

| | After `POST /__admin/reset` |
| --- | --- |
| Records and ids | The emulator's seed data, or the boot `snapshot` |
| Clock | The boot clock, following the base clock again |
| Seed and random streams | The boot seed, from the start |
| Faults, latency, virtual time | The boot controls |
| Snapshots, checkpoints, branches | None |
| Journal and metrics | Empty |

Three things are not the namespace's, and a namespace reset leaves them:

- **Credential mappings.** They route requests. `DELETE /__admin/credentials` clears them.
- **Fault rules with `"namespace": "*"`.** `?all=1` clears them.
- **The base clock.** `?all=1` returns it to where it stood at boot.

A reset discards snapshots. To keep a baseline across tests, [snapshot it and restore](SNAPSHOT_AND_RESTORE.md) instead.

## Errors

| Status | When |
| --- | --- |
| `400` | `x-mockingbird-reset` is not `true` or `false`, or is combined with `x-mockingbird-restore` or `x-mockingbird-at` |
| `401` | The emulator has an admin key and the request did not carry it |

## Related

- [Snapshot and restore](SNAPSHOT_AND_RESTORE.md) to return to a state you chose, not to boot.
- [Boot configuration](BOOT.md) for what "boot" is.
- [Namespaces](NAMESPACES.md) for `DELETE /__admin/namespaces/<key>`, which resets and forgets.
