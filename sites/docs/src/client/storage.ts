/** localStorage that never throws: private windows and blocked storage just forget. */
export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value)
    } catch {
      // Preference is not persisted; the page still works.
    }
  },
  getJson<T>(key: string, fallback: T): T {
    const raw = store.get(key)
    if (!raw) return fallback
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  },
  setJson(key: string, value: unknown): void {
    store.set(key, JSON.stringify(value))
  },
}

export const KEYS = {
  theme: "mb:theme",
  packageManager: "mb:pm",
  servicesView: "mb:services:view",
  recent: "mb:recent",
} as const
