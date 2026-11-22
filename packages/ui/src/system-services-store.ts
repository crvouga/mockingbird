/**
 * The host's `SystemServices` as the view uses it: one list shared by the System screen and the
 * switcher's dev badge. A switch made on the screen, and every change the host's own `subscribe`
 * reports, reaches both. Framework-free, so it can be tested without a DOM.
 */
import type { SystemService, SystemServices } from "./system-types.js"

export type ServicesStore = {
  /** What the screen calls: the host's services, with `subscribe` always present. */
  services: SystemServices & { subscribe(listener: () => void): () => void }
  /** The services from the latest list, or undefined before the first one. */
  latest(): readonly SystemService[] | undefined
  /** Called whenever `latest()` changes. */
  watch(listener: () => void): () => void
  /** Lists again (sharing a list already on its way that started after the last change). */
  refresh(): Promise<void>
}

/** The services not running emulated in this tab. */
export const notEmulated = (services: readonly SystemService[] | undefined) =>
  (services ?? []).filter((service) => service.mode !== "emulated")

export function trackServices(inner: SystemServices): ServicesStore {
  let latest: readonly SystemService[] | undefined
  /** Bumped by every change, so a list that began before it is not shared after it. */
  let generation = 0
  let inflight: { generation: number; promise: ReturnType<SystemServices["list"]> } | undefined
  const watchers = new Set<() => void>()
  const changed = new Set<() => void>()
  const publish = (next: readonly SystemService[]) => {
    latest = next
    for (const watcher of [...watchers]) watcher()
  }
  const announce = () => {
    generation++
    for (const listener of [...changed]) listener()
  }

  const list: SystemServices["list"] = () => {
    if (inflight?.generation === generation) return inflight.promise
    const mine = generation
    const promise = inner.list().then((result) => {
      if (mine === generation) publish(result.services)
      return result
    })
    inflight = { generation: mine, promise }
    const clear = () => {
      if (inflight?.promise === promise) inflight = undefined
    }
    promise.then(clear, clear)
    return promise
  }

  const services: ServicesStore["services"] = {
    list,
    async setMode(id, mode) {
      await inner.setMode(id, mode)
      if (latest)
        publish(latest.map((service) => (service.id === id ? { ...service, mode } : service)))
      announce()
    },
    subscribe(listener) {
      changed.add(listener)
      const stop = inner.subscribe?.(listener)
      return () => {
        changed.delete(listener)
        stop?.()
      }
    },
    ...(inner.test ? { test: (id: string) => inner.test?.(id) ?? Promise.reject() } : {}),
  }

  // The host's own changes start a new generation too, so the next list is fresh.
  return {
    services,
    latest: () => latest,
    watch(listener) {
      watchers.add(listener)
      const stop = inner.subscribe?.(() => {
        generation++
        void list().catch(() => {})
      })
      return () => {
        watchers.delete(listener)
        stop?.()
      }
    },
    refresh: () => list().then(() => {}),
  }
}
