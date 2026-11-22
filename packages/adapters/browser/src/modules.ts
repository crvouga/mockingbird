export type RuntimeModuleLoader = () => unknown

/** Only declared modules may be loaded; this never resolves paths or loads code at runtime. */
export function createModuleRegistry(loaders: Readonly<Record<string, RuntimeModuleLoader>>) {
  const entries = new Map(Object.entries(loaders))
  const loaded = new Map<string, unknown>()
  const require = (name: string): unknown => {
    if (loaded.has(name)) return loaded.get(name)
    const load = entries.get(name)
    if (!load)
      throw Object.assign(new Error(`Module is not in the browser registry: ${name}`), {
        code: "MODULE_NOT_FOUND",
      })
    const value = load()
    loaded.set(name, value)
    return value
  }
  return { require, has: (name: string) => entries.has(name), clear: () => loaded.clear() }
}
