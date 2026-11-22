/// <reference lib="dom" />
/**
 * URL-backed surfaces (`SystemSurface.frame`): the harness creates the `<iframe>`, keeps each
 * frame's last inner path in its `storage`, follows the frame's own navigations without polling,
 * and holds the panel's loading state until the page says it is ready.
 */

/** A same-origin page shown in an iframe, in place of a surface's `mount`. */
export type SystemFrame = {
  /**
   * The page's address (absolute, or relative to the shell's page). A function receives the
   * frame's last inner path (`pathname + search + hash`, kept under `FRAME_PATHS_KEY` in the
   * harness's `storage`), undefined the first time, so a reload or a remount reopens it there.
   */
  src: string | ((lastPath: string | undefined) => string)
  /** The iframe's `name`. */
  name?: string
  /** The iframe's `allow` (permissions policy), such as `"camera; microphone"`. */
  allow?: string
  /**
   * Maps the frame's current location to the tab's address (absolute, or relative to it). Called
   * when the frame navigates (same-origin only) while its surface is shown, replacing the
   * address, and when the surface is shown, as the address that switch writes. `undefined`
   * leaves the address as it is.
   */
  address?(frameLocation: Location): string | undefined
  /**
   * Resolves when the page is usable, so the panel's loading state covers its start-up; rejects
   * to show the panel's error and Retry. Default: the frame's first `load`. Bounded by the
   * harness's `readyTimeoutMs`; `signal` aborts when the surface is disposed or times out.
   */
  ready?(frame: HTMLIFrameElement, signal: AbortSignal): Promise<void>
}

/** Where the harness keeps each frame surface's last inner path: `{ [id]: path }` as JSON. */
export const FRAME_PATHS_KEY = "mockingbird.system-harness.frame-paths"

/** How long a frame surface may take to become ready before its panel shows an error. */
export const DEFAULT_FRAME_READY_TIMEOUT_MS = 30_000

type Store = Pick<Storage, "getItem" | "setItem">

const readPaths = (storage: Store): Record<string, string> => {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(FRAME_PATHS_KEY) ?? "{}")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    )
  } catch {
    return {}
  }
}

/** The last inner path a frame surface was at, if one was kept. */
export function readFramePath(storage: Store, id: string): string | undefined {
  return readPaths(storage)[id]
}

/** Keeps a frame surface's inner path; a store that refuses (quota, privacy mode) is ignored. */
export function writeFramePath(storage: Store, id: string, path: string): void {
  const paths = readPaths(storage)
  if (paths[id] === path) return
  try {
    storage.setItem(FRAME_PATHS_KEY, JSON.stringify({ ...paths, [id]: path }))
  } catch {
    /* The path is a convenience: a store that cannot keep it must not break navigation. */
  }
}

/** A location's inner path: `pathname + search + hash`. */
export const innerPath = (location: Pick<Location, "pathname" | "search" | "hash">): string =>
  location.pathname + location.search + location.hash

/**
 * The frame's document location when the shell may read it (same origin) and it is a real page
 * (not the `about:blank` an iframe starts with); undefined otherwise.
 */
export function frameLocation(frame: HTMLIFrameElement): Location | undefined {
  try {
    const location = frame.contentWindow?.location
    if (!location || location.href === "about:blank" || location.protocol === "about:") return
    return location
  } catch {
    return undefined
  }
}

/** The frame's window when the shell may reach into it (same origin); undefined otherwise. */
function sameOriginWindow(frame: HTMLIFrameElement): Window | undefined {
  try {
    const inner = frame.contentWindow
    if (!inner) return
    // Throws across origins.
    void inner.location.href
    return inner
  } catch {
    return undefined
  }
}

/** The default `ready`: the frame's first `load` of a real page (cross-origin counts as loaded). */
export const loaded = (frame: HTMLIFrameElement, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    const onLoad = () => {
      let blank = false
      try {
        blank = frame.contentWindow?.location.href === "about:blank" && frame.src !== "about:blank"
      } catch {
        /* Cross-origin: it loaded. */
      }
      if (blank) return
      frame.removeEventListener("load", onLoad)
      resolve()
    }
    frame.addEventListener("load", onLoad)
    signal.addEventListener("abort", () => frame.removeEventListener("load", onLoad), {
      once: true,
    })
  })

export type FrameMountOptions = {
  id: string
  label: string
  frame: SystemFrame
  storage(): Store
  /** Milliseconds `ready` may take; `Infinity` waits for ever. */
  timeoutMs: number
  /** After each same-origin navigation of the frame, once its path is kept. */
  navigated?(location: Location): void
  /** Told the iframe when it is created, and `undefined` when it is removed. */
  attach?(frame: HTMLIFrameElement | undefined): void
}

/**
 * Draws the frame into `content` and resolves with its disposer once the page is ready. On a
 * failed or timed-out `ready`, or an abort, it removes the frame and rejects.
 *
 * Navigations are followed by events, never by polling: on each frame `load`, the Navigation API's
 * `currententrychange` on the frame's window where it exists (which also sees `pushState`), else
 * its `popstate` and `hashchange`.
 */
export async function mountFrame(
  content: HTMLElement,
  signal: AbortSignal,
  options: FrameMountOptions,
): Promise<() => void> {
  const { id, label, frame: spec } = options
  const doc = content.ownerDocument
  const frame = doc.createElement("iframe")
  if (spec.name !== undefined) frame.name = spec.name
  if (spec.allow !== undefined) frame.setAttribute("allow", spec.allow)
  frame.title = label
  frame.dataset.surface = id
  frame.style.cssText = "display:block;width:100%;height:100%;border:0"

  const report = () => {
    const location = frameLocation(frame)
    if (!location) return
    writeFramePath(options.storage(), id, innerPath(location))
    options.navigated?.(location)
  }
  let detachInner: (() => void) | undefined
  const track = () => {
    detachInner?.()
    detachInner = undefined
    const inner = sameOriginWindow(frame)
    if (!inner) return
    const navigation = (inner as unknown as { navigation?: EventTarget }).navigation
    if (navigation && typeof navigation.addEventListener === "function") {
      navigation.addEventListener("currententrychange", report)
      detachInner = () => navigation.removeEventListener("currententrychange", report)
    } else {
      inner.addEventListener("popstate", report)
      inner.addEventListener("hashchange", report)
      detachInner = () => {
        inner.removeEventListener("popstate", report)
        inner.removeEventListener("hashchange", report)
      }
    }
    report()
  }
  frame.addEventListener("load", track)
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    frame.removeEventListener("load", track)
    try {
      detachInner?.()
    } catch {
      /* The frame's document may already be gone. */
    }
    detachInner = undefined
    frame.remove()
    options.attach?.(undefined)
  }

  if (signal.aborted) throw signal.reason ?? new Error("Aborted")
  frame.src =
    typeof spec.src === "function" ? spec.src(readFramePath(options.storage(), id)) : spec.src
  content.append(frame)
  options.attach?.(frame)
  try {
    await settle(frame, signal, options)
  } catch (error) {
    dispose()
    throw error
  }
  return dispose
}

/** Runs `ready`, bounded by the timeout and the surface's signal. */
async function settle(
  frame: HTMLIFrameElement,
  signal: AbortSignal,
  { label, frame: spec, timeoutMs }: FrameMountOptions,
): Promise<void> {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  signal.addEventListener("abort", onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const bounded = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
      once: true,
    })
    if (timeoutMs !== Number.POSITIVE_INFINITY)
      timer = setTimeout(
        () =>
          controller.abort(
            new Error(`${label} did not become ready within ${formatMs(timeoutMs)}`),
          ),
        timeoutMs,
      )
  })
  // Called now, before the frame can fire `load`, so a `ready` listening for it never misses it.
  let ready: Promise<void>
  try {
    ready = Promise.resolve((spec.ready ?? loaded)(frame, controller.signal))
  } catch (error) {
    ready = Promise.reject(error)
  }
  // Whichever loses settles later, unobserved.
  bounded.catch(() => {})
  ready.catch(() => {})
  try {
    await Promise.race([ready, bounded])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  }
}

const formatMs = (ms: number) => (ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`)
