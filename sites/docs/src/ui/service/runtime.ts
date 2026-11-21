/**
 * The in-browser builds of the emulators, one lazy chunk each (`virtual:mockingbird/runtimes`).
 * Only the browser asks for them: the server render of a playground never loads an emulator, and
 * the constant `import.meta.env.SSR` keeps the chunks out of the server bundle.
 */
// biome-ignore lint/suspicious/noExplicitAny: each service module has its own export shape.
type Loader = () => Promise<any>

const loadersModule: (() => Promise<{ loaders: Record<string, Loader> }>) | null = import.meta.env
  .SSR
  ? null
  : () => import("virtual:mockingbird/runtimes")

export async function runtimeLoader(service: string): Promise<Loader | undefined> {
  if (!loadersModule) return undefined
  return (await loadersModule()).loaders[service]
}

/** Fetch an emulator's chunk early (on hover or focus), so the first request is quick. */
export function warm(service: string): void {
  void runtimeLoader(service)
    .then((load) => load?.())
    .catch(() => {})
}

/** "⌘↵" on Apple platforms, "Ctrl ↵" elsewhere (after hydration; the server renders "⌘↵"). */
export function modEnterLabel(): string {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘↵" : "Ctrl ↵"
}
