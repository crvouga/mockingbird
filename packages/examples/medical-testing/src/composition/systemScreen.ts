import type {
  SystemBackend,
  SystemBackends,
  SystemFactsSection,
  SystemServiceField,
  SystemServiceMode,
  SystemServices,
  SystemServiceTest,
  SystemTimelineStep,
} from "@crvouga/mockingbird-ui"
import { SYSTEM_SERVICES } from "./services.js"

/**
 * The lab's additions to the System screen (#903): a service that takes the developer's own key,
 * the start-up timings of the in-tab backend, and a read-only Configuration section. Each is
 * optional; the screen works without them.
 */

/** Stripe takes a test-mode key typed on the System screen, for previews with no dev proxy. */
export const STRIPE_KEY_FIELDS: readonly SystemServiceField[] = [
  { name: "secretKey", label: "Secret key", secret: true, placeholder: "sk_test_…" },
  {
    name: "account",
    label: "Account",
    options: [
      { value: "test", label: "Test mode" },
      { value: "sandbox", label: "Sandbox" },
    ],
  },
]

/** Only a non-production key is accepted: a live key is refused before it is kept. */
export const checkStripeKey = (values: Record<string, string>): SystemServiceTest => {
  const key = values.secretKey ?? ""
  if (/^(sk|rk)_live_/.test(key))
    return { ok: false, message: "That is a live key. Use a test-mode or sandbox key." }
  if (!/^(sk|rk)_test_\w{8,}$/.test(key))
    return { ok: false, message: "A Stripe test key starts with sk_test_ or rk_test_." }
  return { ok: true, message: `Looks like a ${values.account ?? "test"} key.` }
}

/**
 * Wraps the dev proxy's controls so one service also takes credentials typed in the browser.
 * The values stay in this object, in memory for this tab only; another host could keep them in
 * IndexedDB. When the proxy can serve the service, its mode is the proxy's; otherwise this
 * wrapper keeps the mode, so the service can still be switched to Dev.
 */
export function withBrowserKey(
  inner: SystemServices,
  spec: {
    id: string
    fields: readonly SystemServiceField[]
    check(values: Record<string, string>): SystemServiceTest
  },
): SystemServices {
  let values: Record<string, string> | undefined
  let ownMode: SystemServiceMode | undefined
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const listener of [...listeners]) listener()
  }
  const proxyServes = async () =>
    (await inner.list()).services.find((service) => service.id === spec.id)?.unavailable ===
    undefined
  return {
    async list() {
      const result = await inner.list()
      return {
        ...result,
        services: result.services.map((service) =>
          service.id === spec.id
            ? {
                ...service,
                fields: spec.fields,
                configured: values !== undefined,
                ...(ownMode ? { mode: ownMode } : {}),
              }
            : service,
        ),
      }
    },
    async setMode(id, mode) {
      if (id !== spec.id || (await proxyServes())) {
        if (id === spec.id) ownMode = undefined
        return inner.setMode(id, mode)
      }
      ownMode = mode === "dev" ? "dev" : undefined
      changed()
    },
    subscribe(listener) {
      listeners.add(listener)
      const stop = inner.subscribe?.(listener)
      return () => {
        listeners.delete(listener)
        stop?.()
      }
    },
    async test(id) {
      if (id === spec.id && ownMode === "dev")
        return values ? spec.check(values) : { ok: false, message: "Save a key first." }
      return inner.test ? inner.test(id) : { ok: false, message: "No dev proxy to test through." }
    },
    async setCredentials(id, next) {
      if (id !== spec.id) throw new Error(`${id} does not take a key here.`)
      const checked = spec.check(next)
      if (!checked.ok) throw new Error(checked.message ?? "That key was refused.")
      values = { ...next }
      changed()
    },
    async clearCredentials(id) {
      if (id !== undefined && id !== spec.id) return
      values = undefined
      ownMode = undefined
      changed()
    },
  }
}

/** The step after which the lab's API answers: its start-up time on the Backends list. */
export const API_READY = "API ready"

/** Marks the steps of a mount, in milliseconds since it began. */
export function startupClock(now: () => number = () => performance.now()) {
  const start = now()
  const steps: SystemTimelineStep[] = []
  return {
    mark(label: string) {
      steps.push({ label, atMs: Math.round(now() - start) })
    },
    steps: (): readonly SystemTimelineStep[] => [...steps],
    /** When the step named `label` was marked, or undefined before it. */
    at: (label: string) => steps.find((step) => step.label === label)?.atMs,
  }
}

/**
 * The Backends list: the lab's API, served in this tab, with how long it took to start, and
 * the emulators beside it; the start-up timeline under them.
 */
export function labBackends(
  clock: ReturnType<typeof startupClock>,
  emulators: readonly { id: string; label: string }[],
): SystemBackends {
  return {
    list: (): SystemBackend[] => {
      const startedInMs = clock.at(API_READY)
      return [
        {
          id: "lab-api",
          label: "Lab API",
          kind: "backend",
          state: "ready",
          ...(startedInMs === undefined ? {} : { startedInMs }),
        },
        ...emulators.map(
          (emulator): SystemBackend => ({
            id: emulator.id,
            label: emulator.label,
            kind: "emulator",
            state: "ready",
          }),
        ),
      ]
    },
    timeline: () => clock.steps(),
  }
}

/** A read-only Configuration section: what this preview runs with, and why a service is fixed. */
export function labConfiguration(options: {
  devProxyUrl?: string | undefined
  keyed: readonly string[]
}): SystemFactsSection {
  return {
    id: "configuration",
    label: "Configuration",
    async load() {
      return [
        {
          group: "Dev resources",
          rows: [
            options.devProxyUrl
              ? { label: "dev-proxy", value: options.devProxyUrl }
              : {
                  label: "dev-proxy",
                  value: "not set",
                  tone: "off" as const,
                  note: "Every service is emulated unless it takes your own key.",
                },
            {
              label: "browser-keys",
              value: options.keyed.length ? options.keyed.join(", ") : "none",
              tone: options.keyed.length ? ("on" as const) : ("muted" as const),
              note: "Kept in memory for this tab only.",
            },
          ],
        },
        {
          group: "Services",
          rows: SYSTEM_SERVICES.map((service) =>
            service.unsupported
              ? {
                  label: service.id,
                  value: "emulated only",
                  tone: "off" as const,
                  note: service.unsupported,
                }
              : { label: service.id, value: "can use dev", tone: "on" as const },
          ),
        },
      ]
    },
  }
}
