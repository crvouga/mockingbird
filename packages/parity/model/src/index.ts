/**
 * Provider-neutral symbolic state for differential testing.
 *
 * Generated commands never mention concrete ids. They talk about `customer #2`; each side of the
 * comparison (the real API and the mock) binds that handle to its own id, and canonicalisation
 * turns both back into `resource:customer:2`.
 */

export type Side = "real" | "mock"
export const SIDES: readonly Side[] = ["real", "mock"]

/** A reference to the n-th resource of a type created during a walk. */
export type SymbolicRef = { type: string; handle: number }

export type SymbolicResource = {
  type: string
  handle: number
  ids: Partial<Record<Side, string>>
}

/** Canonical stand-in for a resource id, identical on both sides. */
export const canonicalToken = (type: string, handle: number) => `resource:${type}:${handle}`

export const describeRef = (ref: SymbolicRef) => `${ref.type} #${ref.handle}`

const idKey = (side: Side, type: string, id: string) => `${side}\u0000${type}\u0000${id}`

/**
 * Bidirectional table between symbolic handles and per-side concrete ids.
 * Handles are allocated sequentially per walk so shrunk sequences stay readable.
 */
export class ResourceTable {
  private readonly byHandle = new Map<number, SymbolicResource>()
  private readonly byId = new Map<string, SymbolicResource>()
  private readonly byType = new Map<string, number[]>()
  private nextHandle = 1

  /** Create a new symbolic resource with no ids bound yet. */
  allocate(type: string): SymbolicResource {
    const resource: SymbolicResource = { type, handle: this.nextHandle++, ids: {} }
    this.byHandle.set(resource.handle, resource)
    const handles = this.byType.get(type) ?? []
    handles.push(resource.handle)
    this.byType.set(type, handles)
    return resource
  }

  /** Bind a concrete id on one side. Rebinding to a different id is an error. */
  bind(handle: number, side: Side, id: string): void {
    const resource = this.byHandle.get(handle)
    if (!resource) throw new RangeError(`unknown handle ${handle}`)
    const existing = resource.ids[side]
    if (existing !== undefined && existing !== id) {
      throw new Error(
        `${describeRef(resource)} is already bound to ${side} id ${existing}, cannot rebind to ${id}`,
      )
    }
    resource.ids[side] = id
    this.byId.set(idKey(side, resource.type, id), resource)
  }

  /** Allocate and bind both sides at once. */
  register(type: string, ids: Partial<Record<Side, string>>): SymbolicResource {
    const resource = this.allocate(type)
    for (const side of SIDES) {
      const id = ids[side]
      if (id !== undefined) this.bind(resource.handle, side, id)
    }
    return resource
  }

  get(handle: number): SymbolicResource | undefined {
    return this.byHandle.get(handle)
  }

  /** Find the symbolic resource a concrete id belongs to on `side`. */
  lookup(side: Side, type: string, id: string): SymbolicResource | undefined {
    return this.byId.get(idKey(side, type, id))
  }

  /** Concrete id of `ref` on `side`, if bound. */
  idOf(ref: SymbolicRef, side: Side): string | undefined {
    return this.byHandle.get(ref.handle)?.ids[side]
  }

  /** Handles of every resource of `type`, in allocation order. */
  handles(type: string): readonly number[] {
    return this.byType.get(type) ?? []
  }

  count(type: string): number {
    return this.handles(type).length
  }

  /** Every resource in allocation order. */
  all(): SymbolicResource[] {
    return [...this.byHandle.values()]
  }

  /** Every bound id on `side`, longest first (so substring replacement never clobbers a prefix). */
  knownIds(side: Side): Array<{ id: string; resource: SymbolicResource }> {
    const out: Array<{ id: string; resource: SymbolicResource }> = []
    for (const resource of this.byHandle.values()) {
      const id = resource.ids[side]
      if (id !== undefined) out.push({ id, resource })
    }
    return out.sort((a, b) => b.id.length - a.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }
}

/** Marker key used for placeholders embedded in generated values. */
export const PLACEHOLDER_KEY = "$mockingbird"

/**
 * Values that the generator leaves symbolic and the executor resolves per side:
 * - `ref`: the `pick`-th existing resource of `type` (modulo count at execution time)
 * - `missing`: a well-formed id that does not exist on either side
 * - `scope`: a run-scoped value (run id, walk start time)
 */
export type Placeholder =
  | { [PLACEHOLDER_KEY]: "ref"; type: string; pick: number }
  | { [PLACEHOLDER_KEY]: "missing"; type: string; missing?: string }
  | { [PLACEHOLDER_KEY]: "scope"; value: string }

export const isPlaceholder = (value: unknown): value is Placeholder =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as Record<string, unknown>)[PLACEHOLDER_KEY] === "string"

export const refPlaceholder = (type: string, pick: number): Placeholder => ({
  [PLACEHOLDER_KEY]: "ref",
  type,
  pick,
})
export const missingPlaceholder = (type: string, missing?: string): Placeholder => ({
  [PLACEHOLDER_KEY]: "missing",
  type,
  ...(missing === undefined ? {} : { missing }),
})
export const scopePlaceholder = (value: string): Placeholder => ({
  [PLACEHOLDER_KEY]: "scope",
  value,
})

/** Depth-first replacement of every placeholder inside a JSON-like value. */
export const resolvePlaceholders = (
  value: unknown,
  resolve: (placeholder: Placeholder) => unknown,
): unknown => {
  if (isPlaceholder(value)) return resolve(value)
  if (Array.isArray(value)) return value.map((item) => resolvePlaceholders(item, resolve))
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = resolvePlaceholders(item, resolve)
    return out
  }
  return value
}

/** Collect every placeholder inside a value (pre-order). */
export const collectPlaceholders = (value: unknown, out: Placeholder[] = []): Placeholder[] => {
  if (isPlaceholder(value)) out.push(value)
  else if (Array.isArray(value)) for (const item of value) collectPlaceholders(item, out)
  else if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) collectPlaceholders(item, out)
  return out
}

/**
 * Resolve a `ref` placeholder against the table: the `pick`-th handle of the type, wrapping around.
 * Returns `undefined` when no resource of that type exists yet.
 */
export const pickRef = (
  table: ResourceTable,
  type: string,
  pick: number,
): SymbolicRef | undefined => {
  const handles = table.handles(type)
  if (handles.length === 0) return undefined
  const handle = handles[pick % handles.length]
  return handle === undefined ? undefined : { type, handle }
}

/** Deterministic, obviously-fake id for `missing` placeholders when the spec supplies none. */
export const defaultMissingId = (type: string) =>
  `mockingbird_missing_${type.replace(/[^a-zA-Z0-9]/g, "_")}`
