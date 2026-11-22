/** Pure helpers behind the System screen: which surfaces the switcher cycles, and service counts. */

/** localStorage key holding the ids left out of the switcher, as a JSON string array. */
export const ROTATION_KEY = "mockingbird.system-switcher.rotation"

type Store = Pick<Storage, "getItem" | "setItem">

/** The ids a person took out of the switcher. Unreadable or malformed storage means none. */
export function readExcluded(storage: () => Store): Set<string> {
  try {
    const saved: unknown = JSON.parse(storage().getItem(ROTATION_KEY) ?? "[]")
    if (Array.isArray(saved))
      return new Set(saved.filter((id): id is string => typeof id === "string" && id !== "system"))
  } catch {
    /* Storage can be unavailable or hold something else; everything stays in rotation. */
  }
  return new Set()
}

export function writeExcluded(storage: () => Store, excluded: ReadonlySet<string>): void {
  try {
    storage().setItem(ROTATION_KEY, JSON.stringify([...excluded].sort()))
  } catch {
    /* Rotation is a convenience; the arrows still work for this session without storage. */
  }
}

/**
 * localStorage key holding the off-by-default ids (`defaultEnabled: false`) a person switched on,
 * as a JSON string array. Without it they stay out of the switcher.
 */
export const INCLUDED_KEY = "mockingbird.system-switcher.included"

/** The off-by-default ids a person switched on. Unreadable or malformed storage means none. */
export function readIncluded(storage: () => Store): Set<string> {
  try {
    const saved: unknown = JSON.parse(storage().getItem(INCLUDED_KEY) ?? "[]")
    if (Array.isArray(saved))
      return new Set(saved.filter((id): id is string => typeof id === "string" && id !== "system"))
  } catch {
    /* Storage can be unavailable or hold something else; off-by-default apps stay off. */
  }
  return new Set()
}

export function writeIncluded(storage: () => Store, included: ReadonlySet<string>): void {
  try {
    storage().setItem(INCLUDED_KEY, JSON.stringify([...included].sort()))
  } catch {
    /* A convenience; the choice holds for this session without storage. */
  }
}

/**
 * The ids out of the switcher when it mounts: the ones a person switched off, plus every
 * off-by-default id they never switched on.
 */
export function initialExcluded(
  storage: () => Store,
  defaultOff: readonly string[],
): { excluded: Set<string>; included: Set<string> } {
  const excluded = readExcluded(storage)
  const included = readIncluded(storage)
  for (const id of defaultOff) if (id !== "system" && !included.has(id)) excluded.add(id)
  return { excluded, included }
}

/** Records one switch flip, keeping both keys consistent. */
export function setRotation(
  storage: () => Store,
  state: { excluded: Set<string>; included: Set<string> },
  defaultOff: readonly string[],
  id: string,
  on: boolean,
): void {
  if (id === "system") return
  if (on) state.excluded.delete(id)
  else state.excluded.add(id)
  if (defaultOff.includes(id)) {
    if (on) state.included.add(id)
    else state.included.delete(id)
    writeIncluded(storage, state.included)
  }
  // Off-by-default ids are left out of ROTATION_KEY: their absence from INCLUDED_KEY says it.
  writeExcluded(
    storage,
    new Set([...state.excluded].filter((value) => !defaultOff.includes(value))),
  )
}

/** localStorage key holding the switcher's order (System included), as a JSON string array. */
export const ORDER_KEY = "mockingbird.system-switcher.order"

/** The saved order. Unreadable or malformed storage means the default order. */
export function readOrder(storage: () => Store, ids: readonly string[]): string[] {
  try {
    const parsed: unknown = JSON.parse(storage().getItem(ORDER_KEY) ?? "[]")
    if (Array.isArray(parsed)) return reconcileOrder(parsed, ids)
  } catch {
    /* Storage can be unavailable or hold something else; the default order stands. */
  }
  return [...ids]
}

/**
 * `wanted` reconciled with the ids that exist: unknown entries are dropped, and an id `wanted`
 * lacks keeps its default place after the id that precedes it in `ids`.
 */
export function reconcileOrder(wanted: readonly unknown[], ids: readonly string[]): string[] {
  const order = [
    ...new Set(wanted.filter((id): id is string => typeof id === "string" && ids.includes(id))),
  ]
  ids.forEach((id, index) => {
    if (order.includes(id)) return
    const before = ids
      .slice(0, index)
      .reverse()
      .find((candidate) => order.includes(candidate))
    order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, id)
  })
  return order
}

export function writeOrder(storage: () => Store, order: readonly string[]): void {
  try {
    storage().setItem(ORDER_KEY, JSON.stringify(order))
  } catch {
    /* The order is a convenience; it holds for this session without storage. */
  }
}

/** The height of the switcher bar across the top of the shell, in CSS pixels. */
export const SWITCHER_BAR_HEIGHT = 24

/**
 * @deprecated The switcher is a fixed bar across the top now and keeps no position; nothing
 * reads or writes this key. Kept so hosts that clear it by name still compile.
 */
export const DOCK_KEY = "mockingbird.system-switcher.dock"

/** `list` with the item at `from` moved to `to`. */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  const [item] = next.splice(from, 1)
  if (item !== undefined) next.splice(Math.max(0, Math.min(to, next.length)), 0, item)
  return next
}

/**
 * The id one step from `current` through `order`, skipping excluded ids. "system" is never
 * excluded, so there is always somewhere to go. An excluded `current` (opened by URL or by its
 * card) still steps from its own place in the order.
 */
export function stepRotation(
  order: readonly string[],
  excluded: ReadonlySet<string>,
  current: string,
  step: -1 | 1,
): string {
  const start = Math.max(0, order.indexOf(current))
  for (let offset = 1; offset <= order.length; offset++) {
    const id = order[(start + step * offset + order.length * offset) % order.length] as string
    if (id === "system" || !excluded.has(id)) return id
  }
  return "system"
}

/** "8 services · 6 emulated · 2 dev" */
export function summarizeServices(services: readonly { mode: "emulated" | "dev" }[]): string {
  const dev = services.filter((service) => service.mode === "dev").length
  const total = services.length
  return `${total} ${total === 1 ? "service" : "services"} · ${total - dev} emulated · ${dev} dev`
}
