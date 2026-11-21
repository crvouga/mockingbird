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

/** "8 services · 6 emulated · 2 sandbox" */
export function summarizeServices(services: readonly { mode: "emulated" | "sandbox" }[]): string {
  const sandbox = services.filter((service) => service.mode === "sandbox").length
  const total = services.length
  return `${total} ${total === 1 ? "service" : "services"} · ${total - sandbox} emulated · ${sandbox} sandbox`
}
