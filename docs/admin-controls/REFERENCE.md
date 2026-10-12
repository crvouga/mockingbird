# Reference

Every admin route, every control header, the error shape and how access is guarded, on one page. Each row links to the page that defines it.

<!-- search: reference api all routes endpoints list index cheat sheet admin key authentication access prefix errors health discovery admin page screens sidebar snapshot restore -->

## Routes

Routes live under `/__admin` by default.

### Discovery and health

| Route | Does |
| --- | --- |
| `GET /__admin` | This list, from the running emulator: every route and control header with a one-line summary and a link to its page |
| `GET /__admin/health` | Readiness. Never needs the admin key or a vendor credential |

A running emulator is its own reference:

```bash
curl localhost:8787/__admin
```

```json
{
  "service": "stripe",
  "namespace": "default",
  "adminPrefix": "/__admin",
  "docs": "https://mockingbird.chrisvouga.dev/docs/admin-controls"
}
```

| Field | Holds |
| --- | --- |
| `routes` | Every route this emulator answers, shared and its own |
| `reference` | `{route, summary, docs}` for each: what it does and the page that defines it |
| `headers` | `{header, value, scope, guarded, summary, docs}` for each control header |
| `guide` | `{title, docs}` for each page of this guide |

### State

| Route | Does | Page |
| --- | --- | --- |
| `POST /__admin/reset` | Return the namespace to boot. `?all=1` for every namespace | [Reset](RESET.md) |
| `GET /__admin/namespaces` | The isolation keys in use | [Namespaces](NAMESPACES.md) |
| `DELETE /__admin/namespaces/:name` | Reset a namespace and forget it | [Namespaces](NAMESPACES.md) |
| `GET /__admin/credentials` | Vendor credential → namespace mappings, masked | [Namespaces](NAMESPACES.md) |
| `PUT /__admin/credentials` | Map vendor credentials to namespaces | [Namespaces](NAMESPACES.md) |
| `DELETE /__admin/credentials` | Remove one mapping (`?credential=`) or all | [Namespaces](NAMESPACES.md) |
| `GET /__admin/snapshots` | List the namespace's snapshots | [Snapshot and restore](SNAPSHOT_AND_RESTORE.md) |
| `POST /__admin/snapshots` | Take a snapshot. `{"name"}` names it | [Snapshot and restore](SNAPSHOT_AND_RESTORE.md) |
| `GET /__admin/snapshots/:id` | Export a snapshot as JSON | [Snapshot and restore](SNAPSHOT_AND_RESTORE.md) |
| `PUT /__admin/snapshots/:id` | Import a snapshot document, without restoring it | [Snapshot and restore](SNAPSHOT_AND_RESTORE.md) |
| `POST /__admin/snapshots/:id/restore` | Replace the namespace with a snapshot | [Snapshot and restore](SNAPSHOT_AND_RESTORE.md) |
| `DELETE /__admin/snapshots/:id` | Delete a snapshot | [Snapshot and restore](SNAPSHOT_AND_RESTORE.md) |
| `GET /__admin/timeline` | Checkpoints and branches | [Checkpoints and branches](CHECKPOINTS_AND_BRANCHES.md) |
| `POST /__admin/checkpoints` | Checkpoint a branch now | [Checkpoints and branches](CHECKPOINTS_AND_BRANCHES.md) |
| `POST /__admin/branches/:name` | Create a branch, optionally from a checkpoint | [Checkpoints and branches](CHECKPOINTS_AND_BRANCHES.md) |
| `POST /__admin/branches/:name/checkout` | Move a branch to a checkpoint | [Checkpoints and branches](CHECKPOINTS_AND_BRANCHES.md) |

### Time

| Route | Does | Page |
| --- | --- | --- |
| `GET /__admin/clock` | Read the namespace clock | [Clock](CLOCK.md) |
| `POST /__admin/clock` | Set, freeze, advance or reset it | [Clock](CLOCK.md) |
| `GET /__admin/latency` | Read the baseline response time | [Latency and timeouts](LATENCY_AND_TIMEOUTS.md) |
| `PUT /__admin/latency` | Set it | [Latency and timeouts](LATENCY_AND_TIMEOUTS.md) |
| `DELETE /__admin/latency` | Remove it | [Latency and timeouts](LATENCY_AND_TIMEOUTS.md) |

### Failure

| Route | Does | Page |
| --- | --- | --- |
| `GET /__admin/faults` | List fault rules. `?all=1` for every namespace | [Faults](FAULTS.md) |
| `POST /__admin/faults` | Add a rule or a preset | [Faults](FAULTS.md) |
| `PUT /__admin/faults` | Replace the namespace's rules | [Faults](FAULTS.md) |
| `DELETE /__admin/faults` | Remove the namespace's rules. `?id=` for one, `?all=1` for every namespace | [Faults](FAULTS.md) |
| `GET /__admin/faults/:id` | One rule, with its counters | [Faults](FAULTS.md) |
| `DELETE /__admin/faults/:id` | Remove one rule | [Faults](FAULTS.md) |
| `GET /__admin/faults/presets` | The named faults this emulator answers to | [Faults](FAULTS.md#presets) |
| `POST /__admin/faults/presets/:name` | Switch a preset on | [Faults](FAULTS.md#presets) |

### Everything at once

| Route | Does | Page |
| --- | --- | --- |
| `GET /__admin/controls` | The namespace's controls in one document | [Control document](CONTROL_DOCUMENT.md) |
| `PUT /__admin/controls` | Apply a control document | [Control document](CONTROL_DOCUMENT.md) |
| `DELETE /__admin/controls` | Put the controls back to boot. Records stay | [Control document](CONTROL_DOCUMENT.md) |

### Inspection

| Route | Does | Page |
| --- | --- | --- |
| `GET /__admin/requests` | The request journal | [Journal, metrics and state](JOURNAL_AND_STATE.md) |
| `DELETE /__admin/requests` | Clear it | [Journal, metrics and state](JOURNAL_AND_STATE.md) |
| `GET /__admin/metrics` | Request counts and unmatched paths | [Journal, metrics and state](JOURNAL_AND_STATE.md#metrics) |
| `DELETE /__admin/metrics` | Clear them | [Journal, metrics and state](JOURNAL_AND_STATE.md#metrics) |
| `GET /__admin/state` | Collections and their fields | [Journal, metrics and state](JOURNAL_AND_STATE.md#state) |
| `GET /__admin/state/:collection` | A page of rows | [Journal, metrics and state](JOURNAL_AND_STATE.md#state) |
| `GET /__admin/state/:collection/:id` | One row | [Journal, metrics and state](JOURNAL_AND_STATE.md#state) |
| `POST /__admin/state/:collection` | Create a row | [Journal, metrics and state](JOURNAL_AND_STATE.md#state) |
| `PUT /__admin/state/:collection/:id` | Replace a row | [Journal, metrics and state](JOURNAL_AND_STATE.md#state) |
| `PATCH /__admin/state/:collection/:id` | Merge into a row | [Journal, metrics and state](JOURNAL_AND_STATE.md#state) |
| `DELETE /__admin/state/:collection/:id` | Delete a row | [Journal, metrics and state](JOURNAL_AND_STATE.md#state) |
| `GET /__admin/ui` · `GET /__admin/ui/` | The admin page | [Journal, metrics and state](JOURNAL_AND_STATE.md#the-admin-page) |
| `GET /__admin/ui/manifest` | The admin page's panels | [Journal, metrics and state](JOURNAL_AND_STATE.md#the-admin-page) |

An emulator adds its own routes beside these (webhook deliveries, an outbox, vendor-specific switches). `GET /__admin` lists them and the emulator's guide explains them.

## Choosing the namespace

Every admin route acts on one [namespace](NAMESPACES.md): the one named by `?namespace=<key>`, else by `x-mockingbird-namespace`, else `default`. `/__admin/ns/<key>/…` reaches the vendor API in that namespace for clients that can only set a base URL.

## Headers

| Header | Value | Page |
| --- | --- | --- |
| `x-mockingbird-namespace` | `<key>` | [Namespaces](NAMESPACES.md) |
| `x-mockingbird-branch` | `<name>` | [Checkpoints and branches](CHECKPOINTS_AND_BRANCHES.md) |
| `x-mockingbird-at` | `<checkpoint>` | [Checkpoints and branches](CHECKPOINTS_AND_BRANCHES.md) |
| `x-mockingbird-reset` | `true` | [Reset](RESET.md) |
| `x-mockingbird-restore` | `<snapshot>` | [Snapshot and restore](SNAPSHOT_AND_RESTORE.md) |
| `x-mockingbird-snapshot` | `<name>` | [Snapshot and restore](SNAPSHOT_AND_RESTORE.md) |
| `x-mockingbird-seed` | `<seed>` | [Seed and determinism](SEED_AND_DETERMINISM.md) |
| `x-mockingbird-time` | `<instant>` | [Clock](CLOCK.md) |
| `x-mockingbird-advance` | `<duration>` | [Clock](CLOCK.md) |
| `x-mockingbird-virtual-time` | `true \| false` | [Latency and timeouts](LATENCY_AND_TIMEOUTS.md#virtual-time) |
| `x-mockingbird-delay` | `<duration>` | [Latency and timeouts](LATENCY_AND_TIMEOUTS.md) |
| `x-mockingbird-timeout` | `<duration>` | [Latency and timeouts](LATENCY_AND_TIMEOUTS.md#timeouts) |
| `x-mockingbird-fault` | status, `drop`, preset, pairs or JSON | [Faults](FAULTS.md#request-header) |
| `x-mockingbird-admin-key` | `<key>` | [Access](#access) |

Scope, order and response headers are on [Request headers](REQUEST_HEADERS.md).

## Values

| Kind | Accepts |
| --- | --- |
| Duration | Milliseconds as a number, or `"250ms"`, `"2s"`, `"15m"`, `"1h"`, `"3d"` |
| Instant | Epoch milliseconds, or ISO-8601 such as `"2030-01-01T00:00:00Z"` |
| Key, name | `[A-Za-z0-9_.-]{1,64}`: namespaces, snapshot names, branch names |
| Seed | A number or a string |

Request bodies are JSON. A `content-type` header is not required.

## Errors

An admin error always has this shape, never a vendor's:

```jsonc
{ "error": { "type": "mockingbird_admin", "message": "no snapshot nope in namespace default" } }
```

| Status | Means |
| --- | --- |
| `400` | A value cannot be read, a key is unknown, or the body is not JSON |
| `401` | The admin key is missing or wrong |
| `404` | No such route, fault, snapshot, preset or row |
| `409` | A history operation cannot apply: no such checkpoint |

A request that is refused has changed nothing.

## Access

Without an admin key the controls are open, which suits a local test process.

Set one with `adminKey` on `createRuntime` or `createServer`, `--admin-key <key>`, or `MOCKINGBIRD_ADMIN_KEY`. Then `x-mockingbird-admin-key: <key>` is required on:

- every admin route except `GET /__admin/health` and the admin page's shell (`GET /__admin/ui`), which holds no data;
- any vendor request carrying a control header that changes state or injects a failure. The three that only select (`x-mockingbird-namespace`, `x-mockingbird-branch`, `x-mockingbird-at`) need no key, except a write with `x-mockingbird-at` on `main`, which rewinds it.

`adminPrefix`, `--admin-prefix <path>` or `MOCKINGBIRD_ADMIN_PREFIX` moves the whole tree from `/__admin` to another path.

## Admin page

`GET /__admin/ui` is the same controls as a page. The hash opens a screen: `http://localhost:8787/__admin/ui#snapshots`. On a narrow window the sidebar collapses to icons; **Jump** (`⌘K` or `Ctrl+K`) searches the names below. The header **Namespace** select is [Namespaces](NAMESPACES.md#admin-page). **Routes** runs any admin route: pick it, fill the path parameters and JSON body, and press Send request.

| Sidebar | Hash | Page |
| --- | --- | --- |
| Overview | `#overview` | [Reset](RESET.md#admin-page) for Reset namespace. Recent requests are the [journal](JOURNAL_AND_STATE.md#the-admin-page) |
| State | `#state` | [Journal, metrics and state](JOURNAL_AND_STATE.md#the-admin-page) |
| Clock | `#clock` | [Clock](CLOCK.md#admin-page) |
| Latency | `#latency` | [Latency and timeouts](LATENCY_AND_TIMEOUTS.md#admin-page) |
| Faults | `#faults` | [Faults](FAULTS.md#admin-page) |
| Snapshot & restore | `#snapshots` | [Snapshot and restore](SNAPSHOT_AND_RESTORE.md#admin-page). **Restore** on a row puts the namespace back |
| Journal | `#journal` | [Journal, metrics and state](JOURNAL_AND_STATE.md#the-admin-page) |
| Checkpoints | `#checkpoints` | [Checkpoints and branches](CHECKPOINTS_AND_BRANCHES.md#admin-page). **Restore** here checks out a checkpoint, not a snapshot |
| Routes | `#routes` | This page. Send `GET /controls`, `PUT /controls`, `POST /snapshots/:id/restore`, or any other admin route |

## Where the controls apply

HTTP emulators have every control in this guide, and a conformance suite runs the same checks against each of them. The PostgreSQL and SQLite engines answer the same `/__admin` routes for reset, snapshots, checkpoints, branches and state; they have no HTTP request to delay or fault, and their snapshots stay in the process. Redis is controlled through its fleet endpoint. A fleet adds one aggregate control listener that resets, snapshots and moves the clock across every service at once; see [Fleets](../FLEETS.md).

The Node server and the CLI destroy the socket for a `drop`, a `timeout` or a `truncate`. `Bun.serve` cannot close a connection from a handler, so the Bun adapter answers `500` for a drop.
