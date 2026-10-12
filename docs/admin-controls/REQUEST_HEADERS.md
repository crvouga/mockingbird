# Request headers

A request can carry its own controls. Nothing needs to be set up first, and a client that can only set default headers still reaches every control.

<!-- search: headers x-mockingbird request header per-request per request inline control without admin api sdk default headers -->

## Interface

| Kind | Headers |
| --- | --- |
| Select what the request sees | `x-mockingbird-namespace` · `x-mockingbird-branch` · `x-mockingbird-at` |
| Change the namespace, then handle the request | `x-mockingbird-reset` · `x-mockingbird-restore` · `x-mockingbird-seed` · `x-mockingbird-time` · `x-mockingbird-advance` · `x-mockingbird-virtual-time` |
| Shape this request only | `x-mockingbird-delay` · `x-mockingbird-timeout` · `x-mockingbird-fault` |
| After the request | `x-mockingbird-snapshot` |
| Access | `x-mockingbird-admin-key` |
| In process | `runtime.headers(input)` builds and checks them |
| Admin page | Not a screen. A control header is sent on the vendor request |

## Admin page

The admin page does not attach control headers to a vendor request. Set the header on the request your application sends. **Routes** runs admin routes only.

`x-mockingbird-restore: <name>` on a vendor request restores that snapshot before the request is handled. The screen for taking and restoring snapshots is [Snapshot and restore](SNAPSHOT_AND_RESTORE.md#admin-page).

## Every header

| Header | Value | Scope | Effect | Page |
| --- | --- | --- | --- | --- |
| `x-mockingbird-namespace` | `<key>` | select | The isolation key | [Namespaces](NAMESPACES.md) |
| `x-mockingbird-branch` | `<name>` | select | Read and write a branch of the namespace's history | [Checkpoints and branches](CHECKPOINTS_AND_BRANCHES.md) |
| `x-mockingbird-at` | `<checkpoint>` | select | Read the namespace as it was at a checkpoint | [Checkpoints and branches](CHECKPOINTS_AND_BRANCHES.md) |
| `x-mockingbird-reset` | `true` | namespace | Reset to boot before the request | [Reset](RESET.md) |
| `x-mockingbird-restore` | `<snapshot>` | namespace | Restore a snapshot before the request | [Snapshot and restore](SNAPSHOT_AND_RESTORE.md) |
| `x-mockingbird-seed` | `<seed>` | namespace | Restart the random streams from this seed | [Seed and determinism](SEED_AND_DETERMINISM.md) |
| `x-mockingbird-time` | `<epoch ms \| ISO-8601>` | namespace | Freeze the clock at this instant | [Clock](CLOCK.md) |
| `x-mockingbird-advance` | `<duration>` | namespace | Move the clock, forward or (negative) back | [Clock](CLOCK.md) |
| `x-mockingbird-virtual-time` | `true \| false` | namespace | Turn virtual time on or off | [Latency and timeouts](LATENCY_AND_TIMEOUTS.md#virtual-time) |
| `x-mockingbird-delay` | `<duration>` | request | Hold this response back, on top of the namespace's latency | [Latency and timeouts](LATENCY_AND_TIMEOUTS.md) |
| `x-mockingbird-timeout` | `<duration>` | request | Never answer: hold this long, then drop the connection | [Latency and timeouts](LATENCY_AND_TIMEOUTS.md#timeouts) |
| `x-mockingbird-fault` | status, `drop`, preset, pairs or JSON | request | Fault this request only | [Faults](FAULTS.md#request-header) |
| `x-mockingbird-snapshot` | `<name>` | namespace | Snapshot after the request; the response echoes the name | [Snapshot and restore](SNAPSHOT_AND_RESTORE.md) |
| `x-mockingbird-admin-key` | `<key>` | | Required with any header above except the three `select` ones, when the emulator has an admin key | [Reference](REFERENCE.md#access) |

### Scope

| Scope | Means |
| --- | --- |
| select | Chooses which state the request reads and writes. Changes nothing by itself |
| namespace | Acts exactly like the matching admin call made just before the request, and persists after it |
| request | Shapes this request only. Nothing is stored |

## Order

The headers on one request apply in a fixed order, whatever order they are sent in:

1. `x-mockingbird-reset`, `x-mockingbird-restore`, `x-mockingbird-seed`, `x-mockingbird-time`, `x-mockingbird-advance`, `x-mockingbird-virtual-time`.
2. The namespace's `autoAdvance`, its latency, then `x-mockingbird-delay`.
3. `x-mockingbird-fault` and `x-mockingbird-timeout`, then the namespace's stored fault rules.
4. The emulator handles the request.
5. `x-mockingbird-snapshot`.

## All or nothing

Every header on a request is checked before any is applied. One that cannot be honoured refuses the request and changes nothing:

| Status | When |
| --- | --- |
| `400` | A value cannot be read, or `x-mockingbird-reset` is combined with `x-mockingbird-restore` or `x-mockingbird-at` (a reset discards the snapshots and history they name) |
| `401` | A header that changes state or injects a failure arrived without the admin key the emulator requires |
| `404` | `x-mockingbird-restore` names a snapshot that is not there |
| `409` | `x-mockingbird-at` names a checkpoint that is not there |

The error is Mockingbird's, never the vendor's: `{"error": {"type": "mockingbird_admin", "message": "…"}}`.

## Example

```bash
curl -X POST localhost:8787/v1/charges \
  -H 'authorization: Bearer sk_test_mockingbird' \
  -H 'x-mockingbird-namespace: worker-3' \
  -H 'x-mockingbird-time: 2030-01-01T00:00:00Z' \
  -H 'x-mockingbird-fault: status=503; delay=2s'
```

The request runs in `worker-3`, whose clock is now frozen at midnight, waits two seconds and answers `503`. The clock stays frozen afterwards; the fault does not.

## Building them

`runtime.headers(...)` builds the headers and checks every value, so a typo fails where it is written and not as a `400` later:

```ts
const response = await fetch("http://localhost:8787/v1/charges", {
  method: "POST",
  headers: {
    authorization: "Bearer sk_test_mockingbird",
    ...stripe.headers({ namespace: "worker-3", time: "2030-01-01T00:00:00Z", fault: "rate_limited" }),
  },
})
```

| Input key | Header | Type |
| --- | --- | --- |
| `namespace` | `x-mockingbird-namespace` | string |
| `branch` | `x-mockingbird-branch` | string |
| `at` | `x-mockingbird-at` | string |
| `reset` | `x-mockingbird-reset` | boolean |
| `restore` | `x-mockingbird-restore` | string |
| `seed` | `x-mockingbird-seed` | number or string |
| `time` | `x-mockingbird-time` | instant or `Date` |
| `advance` | `x-mockingbird-advance` | duration |
| `virtualTime` | `x-mockingbird-virtual-time` | boolean |
| `delay` | `x-mockingbird-delay` | duration |
| `timeout` | `x-mockingbird-timeout` | duration |
| `fault` | `x-mockingbird-fault` | a status, `"drop"`, a preset name, or a fault rule |
| `snapshot` | `x-mockingbird-snapshot` | string |
| `adminKey` | `x-mockingbird-admin-key` | string |

`controlHeaders` from `@crvouga/mockingbird-service` is the same function without a runtime.

## Response headers

| Header | When | Value |
| --- | --- | --- |
| `x-mockingbird` | Always | `<service>@<version>; ns=<namespace>` |
| `x-mockingbird-checkpoint` | After a successful write | The checkpoint the write was filed under |
| `x-mockingbird-fault` | A fault rule answered or shaped the response | The rule's id, or `request` for a fault sent in a header |
| `x-mockingbird-snapshot` | The request asked for a snapshot | The snapshot's name |
| `x-mockingbird-branch` · `x-mockingbird-at` | The request read a branch or a checkpoint | The branch, the checkpoint |

## Related

- [Control document](CONTROL_DOCUMENT.md) for the same controls as JSON.
- [Reference](REFERENCE.md) for every route.
