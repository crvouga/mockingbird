import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Clock, ClockState } from "./clock.js"
import type { ControlHeaderInput, MockControls, NamespaceControls } from "./controls.js"
import type { CredentialRegistry } from "./credentials.js"
import type { FaultRegistry, FaultRule } from "./faults.js"
import type { Journal } from "./journal.js"
import type { LatencyRegistry } from "./latency.js"
import type { Metrics } from "./metrics.js"
import type { Rng } from "./rng.js"
import type { NamespaceSnapshot } from "./snapshot.js"
import type { StateView } from "./state-view.js"

/**
 * What every mock can be called with. A service may accept more fields — accounts,
 * catalogs, webhook endpoints — and those stay optional so `createRuntime()` and
 * `createRuntime({ seed, adminKey })` work everywhere.
 */
export type MockCreateOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  /** All internal HTTP paths live below this prefix. Default /__admin. */
  adminPrefix?: string
  adminKey?: string
  /**
   * Admin controls to boot with: clock, latency, faults, seed, a starting snapshot, and
   * per-namespace overrides. `POST /__admin/reset` returns to exactly this.
   */
  adminControls?: MockControls
}

/** A named snapshot, as the admin API and `runtime.snapshots` list it. */
export type MockSnapshotInfo = {
  readonly id: string
  readonly namespace: string
  readonly records: number
  readonly at: number
  readonly portable: boolean
}

/** One namespace's controls, as `GET /__admin/controls` and `runtime.controls()` report them. */
export type MockControlState = {
  readonly namespace: string
  readonly seed: number | string
  readonly clock: ClockState & { iso: string; autoAdvanceMs: number }
  readonly virtualTime: boolean
  readonly latency: unknown
  readonly faults: readonly unknown[]
  readonly snapshots: readonly MockSnapshotInfo[]
}

/** A checkpoint head the admin client can show. Services may return a richer object. */
export type MockCheckpoint = {
  readonly id: string
  readonly branch: string
  readonly parent: string | null
  readonly at: number
}

/** The instance behind one namespace. Vendor methods sit beside these, not instead of them. */
export type MockInstanceSurface = {
  fetch(request: Request): Promise<Response>
  reset(): Promise<void>
}

/**
 * The interface every mock runtime implements.
 *
 * Assignability is one way: a service may add methods (`tick`, a typed webhook hub,
 * account directories) and narrower property types. Removing or renaming a member
 * fails the typecheck. The HTTP control plane (`/__admin/health`, `/__admin/*`) is the same
 * contract on the wire; {@link STANDARD_ADMIN_ROUTES} is that list.
 */
export type MockSurface = {
  readonly name: string
  fetch(request: Request): Promise<Response>
  readonly clock: Clock
  readonly faults: FaultRegistry
  /** Baseline response time per namespace. */
  readonly latency: LatencyRegistry
  readonly metrics: Metrics
  readonly journal: Journal
  readonly rng: Rng
  readonly credentials: CredentialRegistry
  /** Present on every runtime. `undefined` when the service has no outbound webhooks. */
  readonly webhooks: unknown
  applyPreset(name: string, namespace?: string, overrides?: Partial<FaultRule>): FaultRule[]
  instance(namespace?: string): MockInstanceSurface
  namespaces(): string[]
  reset(namespace?: string): Promise<void>
  /** A namespace's clock: the base clock for `default`, its own for any other. */
  namespaceClock(namespace?: string): Clock
  /** A namespace's controls: seed, clock, virtual time, latency, faults and snapshots. */
  controls(namespace?: string): MockControlState
  /** Apply a control document to a namespace. A given key replaces that control. */
  configure(controls: NamespaceControls, namespace?: string): MockControlState
  /** Named snapshots of a namespace: records, clock, random streams, faults and latency. */
  readonly snapshots: {
    create(options?: { name?: string; namespace?: string }): MockSnapshotInfo
    list(namespace?: string): MockSnapshotInfo[]
    restore(id: string, namespace?: string): void
    delete(id: string, namespace?: string): boolean
  }
  /** Request headers that carry controls, checked: spread them into a `fetch` or an SDK's defaults. */
  headers(input: ControlHeaderInput): Record<string, string>
  snapshot(namespace?: string): NamespaceSnapshot
  restore(snapshot: NamespaceSnapshot, namespace?: string): void
  checkpoint(namespace?: string, branch?: string): MockCheckpoint
  branch(name: string, options?: { namespace?: string; at?: string }): MockCheckpoint
  checkout(checkpoint: string, options?: { namespace?: string; branch?: string }): void
  timeline(namespace?: string): {
    head(branch?: string): { readonly id: string } | undefined
    branches(): Readonly<Record<string, string>>
  }
  /** Collections in `namespace`, declared by the service and inferred from stored rows. */
  state(namespace?: string): StateView
  readonly sqlite: SqliteClient
}

/**
 * Keep a service's own runtime type while proving it is a {@link MockSurface}.
 * Extra members stay. A missing member is a type error at the definition.
 */
export const defineMock = <T extends MockSurface>(runtime: T): T => runtime

/** Clock state is part of the surface so admin clients can render it without a cast. */
export type MockClockState = ClockState

/**
 * What each shared admin route does. `GET /__admin` serves this list, and the guide in
 * `docs/ADMIN_CONTROLS.md` is checked against it.
 */
export const ADMIN_ROUTE_REFERENCE = {
  "GET /": "This index: every route and control header, with a one-line summary each.",
  "GET /health": "Readiness. Never needs the admin key or a vendor credential.",
  "GET /controls":
    "The namespace's controls in one document: seed, clock, virtual time, latency, faults, snapshots.",
  "PUT /controls":
    "Apply a control document. Each key given replaces that control; `snapshot` replaces the records.",
  "DELETE /controls": "Put the namespace's controls back to boot. Records are untouched.",
  "POST /reset":
    "Return the namespace to its boot state: records, controls, snapshots, journal, metrics. `?all=1` resets every namespace.",
  "GET /namespaces": "The isolation keys in use.",
  "DELETE /namespaces/:name": "Reset a namespace and forget it.",
  "GET /clock": "The namespace clock: `now`, `iso`, `frozen`, `offsetMs`, `autoAdvanceMs`.",
  "POST /clock":
    "Move time: `now` (or `set`), `advance`, `frozen` (or `freeze`), `autoAdvance`, `reset`.",
  "GET /latency": "The namespace's baseline response time.",
  "PUT /latency": "Set it: `delay`, seeded `jitter`, and per-operation `operations`.",
  "DELETE /latency": "Remove it.",
  "GET /faults": "Fault rules that can hit this namespace. `?all=1` lists every namespace's.",
  "POST /faults": 'Add a fault rule, or a preset with `{"preset": "<name>"}`.',
  "PUT /faults": 'Replace the namespace\'s fault rules with `{"faults": [...]}`.',
  "DELETE /faults":
    "Remove the namespace's fault rules. `?id=` removes one; `?all=1` every namespace's.",
  "GET /faults/presets": "Named faults this emulator answers to.",
  "POST /faults/presets/:name": "Switch a preset on. The body overrides its fields.",
  "GET /faults/:id": "One fault rule, with its `hits`, `seen` and `remaining` counters.",
  "DELETE /faults/:id": "Remove one fault rule.",
  "GET /snapshots": "The namespace's snapshots.",
  "POST /snapshots":
    'Snapshot the namespace: records, clock, random streams, faults, latency. `{"name"}` names it.',
  "GET /snapshots/:id": "A snapshot as portable JSON.",
  "PUT /snapshots/:id": "Store a snapshot document under this id, without restoring it.",
  "POST /snapshots/:id/restore": "Replace the namespace with a snapshot.",
  "DELETE /snapshots/:id": "Delete a snapshot.",
  "GET /timeline": "The namespace's checkpoint history and branches.",
  "POST /checkpoints": "Checkpoint a branch now. Successful mutations do this automatically.",
  "POST /branches/:name": "Create a copy-on-write branch, optionally from a checkpoint (`at`).",
  "POST /branches/:name/checkout": "Move a branch to a checkpoint.",
  "GET /requests":
    "The request journal. Filter with `operationId`, `method`, `path`, `status`, `faultId`, `since`, `limit`; `?all=1` for every namespace.",
  "DELETE /requests": "Clear the journal.",
  "GET /metrics": "Request counts and unmatched paths, for every namespace or the one named.",
  "DELETE /metrics": "Clear them.",
  "GET /credentials": "Vendor credential → namespace mappings, masked.",
  "PUT /credentials": "Map vendor credentials to namespaces, for SDKs that cannot send a header.",
  "DELETE /credentials": "Remove one mapping (`?credential=`) or all.",
  "GET /state": "The namespace's collections: declared shape and stored rows.",
  "GET /state/:collection": "A page of rows.",
  "GET /state/:collection/:id": "One row.",
  "POST /state/:collection": "Create a row from `{id?, value}`.",
  "PUT /state/:collection/:id": "Replace a row.",
  "PATCH /state/:collection/:id": "Shallow-merge into a row.",
  "DELETE /state/:collection/:id": "Delete a row.",
  "GET /ui": "The admin UI.",
  "GET /ui/": "The admin UI.",
  "GET /ui/manifest": "The admin UI's panels and extensions.",
} as const

/**
 * Admin routes every mock answers. A service adds its own keys beside these.
 * A key in this list keeps the shared handler, so the state API and the admin UI
 * stay the same when a service also ships vendor-specific controls.
 */
export const STANDARD_ADMIN_ROUTES = Object.keys(
  ADMIN_ROUTE_REFERENCE,
) as readonly (keyof typeof ADMIN_ROUTE_REFERENCE)[]

export type StandardAdminRoute = (typeof STANDARD_ADMIN_ROUTES)[number]

/**
 * A contribution the admin shell mounts beside the shared views.
 * `panel` is author-owned markup. `sql` turns on the built-in table explorer
 * and query runner, which call `GET /sql/tables` and `POST /sql/query`.
 * `route` presents an admin action with the shell's prebuilt form and response view.
 */
export type AdminExtension =
  | {
      kind: "route"
      id: string
      title: string
      description?: string
      /** An existing admin route, including its method and any path parameters. */
      route: string
      /** Initial JSON body shown in the request form. */
      body?: unknown
    }
  | {
      kind: "panel"
      id: string
      title: string
      description?: string
      html: string
      script?: string
    }
  | {
      kind: "sql"
      /** DOM id suffix. Default `sql`. */
      id?: string
      title?: string
      description?: string
    }

/** A panel the default admin shell mounts after the shared views. */
export type AdminPanel = {
  /** DOM id suffix. Lowercase letters, digits, and hyphens. */
  id: string
  title: string
  description?: string
  /** Markup placed inside the panel body. The service author owns it. */
  html: string
  /**
   * Function body called as `(root, api) => void` once the shell has loaded.
   * `root` is the panel body. `api` is `{ get, send, namespace }` against `/__admin`.
   */
  script?: string
}

/**
 * How a service customizes the admin UI without leaving the shared shell.
 * `panels` add views. `render` replaces the document and can call `defaultHtml()`
 * to wrap the shared shell instead of discarding it.
 */
export type AdminUi = {
  panels?: readonly AdminPanel[]
  /** First-class shell contributions. `sql` mounts the shared database explorer. */
  extensions?: readonly AdminExtension[]
  render?: (input: { service: string; defaultHtml: () => string }) => string
}

const PANEL_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const RESERVED_VIEWS = new Set([
  "overview",
  "state",
  "clock",
  "latency",
  "faults",
  "snapshots",
  "journal",
  "routes",
  "checkpoints",
])

const checkPanel = (
  panel: { id: string; title: string },
  seen: Set<string>,
  label: string,
): void => {
  if (!PANEL_ID.test(panel.id)) {
    throw new RangeError(`${label} id must match ${PANEL_ID}: ${JSON.stringify(panel.id)}`)
  }
  if (RESERVED_VIEWS.has(panel.id)) {
    throw new RangeError(`${label} id ${panel.id} is reserved by the admin shell`)
  }
  if (seen.has(panel.id)) throw new RangeError(`duplicate admin view id ${panel.id}`)
  seen.add(panel.id)
  if (panel.title.trim() === "") throw new RangeError(`${label} ${panel.id} needs a title`)
}

/** Reject a panel or extension the shell cannot mount. Called when the runtime is created. */
export const assertAdminUi = (ui: AdminUi | undefined): void => {
  if (!ui) return
  const seen = new Set<string>()
  for (const panel of ui.panels ?? []) checkPanel(panel, seen, "admin panel")
  for (const extension of ui.extensions ?? []) {
    if (extension.kind === "panel" || extension.kind === "route") {
      checkPanel(extension, seen, "admin extension")
      if (
        extension.kind === "route" &&
        !/^(GET|POST|PUT|PATCH|DELETE) \/\S*$/.test(extension.route)
      )
        throw new RangeError(`admin extension ${extension.id} needs a method and route path`)
      continue
    }
    const id = extension.id ?? "sql"
    checkPanel({ id, title: extension.title ?? "SQL" }, seen, "admin extension")
  }
}
