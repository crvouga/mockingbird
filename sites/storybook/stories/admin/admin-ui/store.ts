/**
 * A Stripe emulator in use, for the admin screens: a catalog, a paying customer, a Checkout
 * Session and a refused request, all made through Stripe's API; and the admin API
 * (`/__admin/*`) the stories call to set clocks, faults, snapshots and checkpoints.
 */
import type { Emulator } from "../../../src/story.js"
import { ORIGIN, stripe } from "../../emulators/stripe/stripe.js"
import type { AdminVisit } from "./admin.js"

export { ORIGIN }

/** Call the emulator's admin API as the admin UI does; returns the parsed JSON body. */
export function control(emulator: Emulator, origin = ORIGIN, prefix = "/__admin") {
  return async (
    method: string,
    path: string,
    body?: unknown,
    namespace = "default",
  ): Promise<unknown> => {
    const response = await emulator.fetch(
      new Request(`${origin}${prefix}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-mockingbird-namespace": namespace },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }
}

/** A store selling two plans, one subscriber, an open Checkout Session and one refused call. */
export async function shop() {
  const s = stripe()
  const starter = await s.plan("Starter", 900)
  await s.plan("Pro", 2900)
  await s.subscriber(starter.id)
  await s.customer({ email: "bob@example.com", name: "Bob Marley" })
  await s.checkout({ mode: "subscription", line_items: [{ price: starter.id, quantity: 1 }] })
  await s.post("/v1/customers", { email: "not-an-email" }).catch(() => undefined)
  await s.post("/v1/charges", { amount: 500 }).catch(() => undefined)
  return { s, admin: control(s.emulator) }
}

/** The admin opened on a store set up by `prepare` (default: `shop()` as is). */
export const store =
  (
    prepare: (opened: Awaited<ReturnType<typeof shop>>) => Promise<unknown> = async () => undefined,
  ) =>
  async (): Promise<AdminVisit> => {
    const opened = await shop()
    await prepare(opened)
    return { emulator: opened.s.emulator, origin: ORIGIN }
  }

/** A Stripe emulator nothing has called yet. */
export const fresh = (): AdminVisit => ({ emulator: stripe().emulator, origin: ORIGIN })
