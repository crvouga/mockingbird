/**
 * Opt-in sandbox quirks: behaviors the vendor sandbox shows that a well-behaved client must
 * tolerate. Every quirk is off by default, so no existing suite changes.
 */
export type JunctionQuirks = {
  /**
   * #474: a `POST /v3/order/{id}/cancel` that lands in the same wall-clock second as the
   * order's creation records its `cancelled.<method>.cancelled` event, but the order's
   * `status`, `last_event` and `updated_at` do not move; a second cancel is a no-op. Reported
   * from the sandbox (production unverified).
   */
  sameSecondCancelStatus?: boolean
}

const KEYS: readonly (keyof JunctionQuirks)[] = ["sameSecondCancelStatus"]

/** Validate quirk input; unknown names and non-boolean values are refused. */
export const quirksFrom = (input: unknown): JunctionQuirks => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new TypeError("quirks must be an object of booleans")
  const out: JunctionQuirks = {}
  for (const [name, value] of Object.entries(input)) {
    if (!KEYS.includes(name as keyof JunctionQuirks))
      throw new TypeError(`unknown quirk ${JSON.stringify(name)}; one of ${KEYS.join(", ")}`)
    if (typeof value !== "boolean") throw new TypeError(`quirk ${name} must be a boolean`)
    out[name as keyof JunctionQuirks] = value
  }
  return out
}
