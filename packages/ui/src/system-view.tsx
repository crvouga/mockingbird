/**
 * The System harness's React view, loaded lazily by `system-harness.ts`. One React root draws the
 * switcher pill (with its tooltip, status dot and update toast) in the harness's chrome layer, and
 * portals each panel's loading or error state and the System screen into their own hosts.
 *
 * Mockingbird's stylesheet goes into the document once, scoped (`scope-css.ts`) to the `.msh-ui`
 * containers this view draws in, so Preflight and HeroUI's classes restyle nothing of the host
 * page or of the surfaces' own content. (Shadow roots would isolate further, but React Aria's
 * press handling, behind every HeroUI button and switch, does not work across a shadow boundary.)
 */
import { ArrowLeft, ArrowRight } from "@gravity-ui/icons"
import { Button, buttonVariants, Card, Separator, Spinner } from "@heroui/react"
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { createPortal, flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { MOCKINGBIRD_CSS } from "../dist/styles.js"
import { MockingbirdProvider, type MockingbirdTheme } from "./react/provider.js"
import { ErrorState, LoadingState } from "./react/states.js"
import { scopeCss } from "./scope-css.js"
import { TONE_FILL, useBuildState, useStore } from "./system-build.js"
import {
  buildStatus,
  nextVersion,
  type SystemBuild,
  secondsUntil,
  shortSha,
} from "./system-build-status.js"
import { SYSTEM_ICONS } from "./system-icons.js"
import { IconMark } from "./system-mark.js"
import { stepRotation } from "./system-rotation.js"
import { SystemScreen } from "./system-screen.js"
import type { HarnessController, HarnessSnapshot, SystemApp } from "./system-types.js"
import { applyStoredTheme, THEME_STORAGE_KEY } from "./theme-preference.js"

// ---- Styles: Mockingbird's stylesheet, scoped to `.msh-ui`, added to the document once.

/** The class every container of this view carries; the stylesheet applies only inside it. */
const SCOPE = "msh-ui"
const STYLE_ID = "mockingbird-system-ui"
let scoped: string | undefined

function ensureStyles(doc: Document) {
  if (doc.getElementById(STYLE_ID)) return
  scoped ??= scopeCss(MOCKINGBIRD_CSS, `.${SCOPE}`)
  const style = doc.createElement("style")
  style.id = STYLE_ID
  style.textContent = scoped
  doc.head.append(style)
}

const containers = new WeakMap<Element, HTMLElement>()
/** A styled container at the end of `host`, made on first use. */
function container(host: HTMLElement, style = ""): HTMLElement {
  const existing = containers.get(host)
  if (existing?.parentNode === host) return existing
  const doc = host.ownerDocument
  ensureStyles(doc)
  const element = doc.createElement("div")
  element.className = SCOPE
  element.style.cssText = style
  host.append(element)
  containers.set(host, element)
  return element
}

// ---- Theme: the host page's pinned light or dark (`class` / `data-theme` on <html>), or the system's.

const pinned = (doc: Document): MockingbirdTheme => {
  const root = doc.documentElement
  const theme = root.dataset.theme
  if (theme === "light" || theme === "dark") return theme
  if (root.classList.contains("dark")) return "dark"
  if (root.classList.contains("light")) return "light"
  return "system"
}
function useHostTheme(doc: Document): MockingbirdTheme {
  const subscribe = useCallback(
    (listener: () => void) => {
      const observer = new MutationObserver(listener)
      observer.observe(doc.documentElement, {
        attributes: true,
        attributeFilter: ["class", "data-theme"],
      })
      return () => observer.disconnect()
    },
    [doc],
  )
  return useSyncExternalStore(subscribe, () => pinned(doc))
}

/** Mounts the view into the harness's chrome layer; the harness disposes it on destroy. */
export function renderHarness(chrome: HTMLElement, controller: HarnessController) {
  const doc = chrome.ownerDocument
  // A theme a person chose on any Mockingbird page of this origin (ThemeSwitch's `mb:theme`).
  if (pinned(doc) === "system")
    try {
      const stored = doc.defaultView?.localStorage.getItem(THEME_STORAGE_KEY)
      if (stored === "light" || stored === "dark") applyStoredTheme(doc.documentElement, stored)
    } catch {
      /* Storage can be blocked; the system theme stands. */
    }
  const root = createRoot(
    // Transparent: the scoped stylesheet gives each container the page background, as <html>.
    container(chrome, "position:absolute;inset:0;pointer-events:none;background:transparent"),
  )
  flushSync(() => root.render(<Harness controller={controller} />))
  return {
    dispose() {
      root.unmount()
    },
  }
}

/**
 * The harness's state, redrawn synchronously on every change, so a status or a Retry button is
 * in the page by the time the `show()` that caused it resolves.
 */
const useSnapshot = (controller: HarnessController): HarnessSnapshot =>
  useStore(controller.subscribe, controller.get)

/**
 * The theme on a layer drawn over the host's own background (the pill, a panel's status): what
 * `MockingbirdProvider` sets, without its page background.
 */
function Layer({
  theme,
  className = "",
  children,
}: {
  theme: MockingbirdTheme
  className?: string
  children: ReactNode
}) {
  return (
    <div
      data-mockingbird
      className={`font-sans text-foreground ${theme === "system" ? "" : theme} ${className}`}
      {...(theme === "system" ? {} : { "data-theme": theme })}
    >
      {children}
    </div>
  )
}

function Portal({
  host,
  theme,
  children,
  style,
  page = false,
}: {
  host: HTMLElement
  theme: MockingbirdTheme
  children: ReactNode
  style?: string
  /** A whole page (the System screen), on the theme's background. */
  page?: boolean
}) {
  return createPortal(
    page ? (
      <MockingbirdProvider theme={theme} className="min-h-full">
        {children}
      </MockingbirdProvider>
    ) : (
      <Layer theme={theme}>{children}</Layer>
    ),
    // Transparent unless it is a page: the scoped stylesheet paints each container as <html>.
    container(host, page ? style : `${style ?? ""};background:transparent`),
  )
}

function Harness({ controller }: { controller: HarnessController }) {
  const snapshot = useSnapshot(controller)
  const theme = useHostTheme(controller.shell.ownerDocument)
  const apps = snapshot.order
    .map((id) => controller.apps.find((app) => app.id === id))
    .filter((app): app is SystemApp => app !== undefined)
  return (
    <>
      <Chrome controller={controller} snapshot={snapshot} theme={theme} />
      {snapshot.statuses.map((status) => (
        <Portal key={status.id} host={status.host} theme={theme}>
          {status.state === "loading" ? (
            <LoadingState />
          ) : (
            <div className="mx-auto max-w-2xl p-6 sm:p-8">
              <ErrorState
                title="Unable to open"
                error={status.message}
                onRetry={() => controller.retry(status.id)}
              />
            </div>
          )}
        </Portal>
      ))}
      {snapshot.systemHost ? (
        <Portal host={snapshot.systemHost} theme={theme} style="min-height:100%" page>
          <div className="msh-home">
            <SystemScreen
              apps={apps}
              excluded={snapshot.excluded}
              open={controller.show}
              setInRotation={controller.setInRotation}
              setOrder={controller.setOrder}
              services={controller.services}
              docsUrl={controller.docsUrl}
              build={controller.build}
            />
          </div>
        </Portal>
      ) : null}
    </>
  )
}

// ---- The switcher pill: arrows through the rotation, dragged to dock on any edge.

type Dock = { edge: "left" | "right" | "top" | "bottom"; at: number }
const DOCK_KEY = "mockingbird.system-switcher.dock"
const MARGIN = 8
type Tip = "previous" | "next" | "dot"

const readDock = (win: Window): Dock => {
  try {
    const saved = JSON.parse(win.localStorage.getItem(DOCK_KEY) ?? "null") as Partial<Dock>
    if (
      saved &&
      ["left", "right", "top", "bottom"].includes(saved.edge ?? "") &&
      typeof saved.at === "number" &&
      saved.at >= 0 &&
      saved.at <= 1
    )
      return saved as Dock
  } catch {
    /* Storage can be unavailable or hold something else; fall back to the default. */
  }
  return { edge: "left", at: 0.5 }
}
const writeDock = (win: Window, value: Dock) => {
  try {
    win.localStorage.setItem(DOCK_KEY, JSON.stringify(value))
  } catch {
    /* The position is a convenience; switching still works without storage. */
  }
}

const ARROW = `${buttonVariants({ variant: "ghost", size: "sm", isIconOnly: true })} rounded-full`

function Chrome({
  controller,
  snapshot,
  theme,
}: {
  controller: HarnessController
  snapshot: HarnessSnapshot
  theme: MockingbirdTheme
}) {
  const { shell, build } = controller
  const win = shell.ownerDocument.defaultView ?? window
  const pill = useRef<HTMLDivElement>(null)
  const tipBox = useRef<HTMLDivElement>(null)
  const buttons = useRef(new Map<Tip, HTMLButtonElement>())
  const placeToast = useRef<() => void>(() => {})
  const [tip, setTip] = useState<Tip>()
  const [dragging, setDragging] = useState(false)
  /** True from a drag's first move until just after its release, so its click does not act. */
  const dragged = useRef(false)

  const appOf = (id: string) =>
    controller.apps.find((app) => app.id === id) ?? (controller.apps[0] as SystemApp)
  const neighbour = (step: -1 | 1) =>
    appOf(stepRotation(snapshot.order, snapshot.excluded, snapshot.current, step))
  const label = (step: -1 | 1) => `${step < 0 ? "Previous" : "Next"}: ${neighbour(step).label}`

  // Docking: where the pill rests, kept across reloads, kept in place across resizes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: set up once per harness.
  useLayoutEffect(() => {
    const switcher = pill.current
    if (!switcher) return
    let dock = readDock(win)
    let x = 0
    let y = 0
    const limits = () => {
      const maxX = Math.max(0, shell.clientWidth - switcher.offsetWidth - MARGIN)
      const maxY = Math.max(0, shell.clientHeight - switcher.offsetHeight - MARGIN)
      return { minX: Math.min(MARGIN, maxX), minY: Math.min(MARGIN, maxY), maxX, maxY }
    }
    const position = () => {
      const { maxX, maxY } = limits()
      x = Math.max(0, Math.min(x, maxX + MARGIN))
      y = Math.max(0, Math.min(y, maxY + MARGIN))
      switcher.style.left = `${x}px`
      switcher.style.top = `${y}px`
      placeToast.current()
    }
    const settle = () => {
      const { minX, minY, maxX, maxY } = limits()
      const along = (min: number, max: number) => min + (max - min) * dock.at
      x = dock.edge === "left" ? minX : dock.edge === "right" ? maxX : along(minX, maxX)
      y = dock.edge === "top" ? minY : dock.edge === "bottom" ? maxY : along(minY, maxY)
      position()
    }
    const snap = () => {
      const { minX, minY, maxX, maxY } = limits()
      x = Math.max(minX, Math.min(x, maxX))
      y = Math.max(minY, Math.min(y, maxY))
      const fraction = (value: number, min: number, max: number) =>
        max > min ? (value - min) / (max - min) : 0.5
      const distances = { left: x - minX, right: maxX - x, top: y - minY, bottom: maxY - y }
      const edge = (Object.keys(distances) as Dock["edge"][]).reduce((a, b) =>
        distances[b] < distances[a] ? b : a,
      )
      dock = {
        edge,
        at: edge === "left" || edge === "right" ? fraction(y, minY, maxY) : fraction(x, minX, maxX),
      }
      writeDock(win, dock)
      switcher.style.transition = win.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "none"
        : "left 160ms ease-out, top 160ms ease-out"
      settle()
    }
    let drag: { x: number; y: number; left: number; top: number } | undefined
    const down = (event: globalThis.PointerEvent) => {
      if (event.button !== 0) return
      dragged.current = false
      switcher.style.transition = "none"
      drag = { x: event.clientX, y: event.clientY, left: x, top: y }
    }
    const moved = (event: globalThis.PointerEvent) => {
      if (!drag) return
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      if (!dragged.current && Math.hypot(dx, dy) > 5) {
        dragged.current = true
        setTip(undefined)
        setDragging(true)
        // Capture only once it is a drag, so a plain press still clicks the arrow under it.
        switcher.setPointerCapture(event.pointerId)
      }
      if (!dragged.current) return
      x = drag.left + dx
      y = drag.top + dy
      position()
    }
    const release = () => {
      if (!drag) return
      drag = undefined
      setDragging(false)
      if (dragged.current) {
        snap()
        // The click that ends a drag arrives after pointerup; let it through on the next task.
        win.setTimeout(() => {
          dragged.current = false
        })
      }
    }
    switcher.addEventListener("pointerdown", down)
    switcher.addEventListener("pointermove", moved)
    switcher.addEventListener("pointerup", release)
    switcher.addEventListener("pointercancel", release)
    switcher.addEventListener("lostpointercapture", release)
    const resize = new ResizeObserver(() => {
      switcher.style.transition = "none"
      settle()
    })
    resize.observe(shell)
    resize.observe(switcher)
    settle()
    return () => {
      resize.disconnect()
      switcher.removeEventListener("pointerdown", down)
      switcher.removeEventListener("pointermove", moved)
      switcher.removeEventListener("pointerup", release)
      switcher.removeEventListener("pointercancel", release)
      switcher.removeEventListener("lostpointercapture", release)
    }
  }, [])

  // Tooltips: hover with a mouse, or keyboard focus. Native listeners, so a synthetic
  // `pointerenter` reaches them as a real one does. The buttons are fixed per harness.
  useEffect(() => {
    const cleanups: (() => void)[] = []
    for (const [name, button] of buttons.current) {
      const enter = (event: globalThis.PointerEvent) => {
        if (event.pointerType === "mouse" && !dragged.current) flushSync(() => setTip(name))
      }
      const leave = () => setTip((current) => (current === name ? undefined : current))
      const focus = () => {
        if (button.matches(":focus-visible")) flushSync(() => setTip(name))
      }
      button.addEventListener("pointerenter", enter)
      button.addEventListener("pointerleave", leave)
      button.addEventListener("focus", focus)
      button.addEventListener("blur", leave)
      cleanups.push(() => {
        button.removeEventListener("pointerenter", enter)
        button.removeEventListener("pointerleave", leave)
        button.removeEventListener("focus", focus)
        button.removeEventListener("blur", leave)
      })
    }
    return () => {
      for (const cleanup of cleanups) cleanup()
    }
  }, [])

  const register = (name: Tip) => (node: HTMLButtonElement | null) => {
    if (node) buttons.current.set(name, node)
    else buttons.current.delete(name)
  }

  const destination = tip === "previous" ? neighbour(-1) : tip === "next" ? neighbour(1) : undefined
  const dotStatus = useDotStatus(build)
  const tipText =
    tip === "dot" ? dotStatus?.text : tip ? label(tip === "previous" ? -1 : 1) : undefined

  // Above the pill, centered on the button, kept inside the shell.
  // biome-ignore lint/correctness/useExhaustiveDependencies: placed whenever its text changes.
  useLayoutEffect(() => {
    const box = tipBox.current
    const target = tip ? buttons.current.get(tip) : undefined
    const switcher = pill.current
    if (!box || !target || !switcher) return
    const outer = shell.getBoundingClientRect()
    const rect = target.getBoundingClientRect()
    const pillRect = switcher.getBoundingClientRect()
    const left = rect.left - outer.left + (rect.width - box.offsetWidth) / 2
    const above = pillRect.top - outer.top - box.offsetHeight - 8
    box.style.left = `${Math.max(4, Math.min(left, shell.clientWidth - box.offsetWidth - 4))}px`
    box.style.top = `${above >= 4 ? above : pillRect.bottom - outer.top + 8}px`
  }, [tip, tipText])

  const go = (step: -1 | 1) => {
    if (dragged.current) return
    controller.show(neighbour(step).id)
  }

  return (
    <Layer theme={theme} className="pointer-events-none absolute inset-0">
      {/* biome-ignore lint/a11y/useSemanticElements: a draggable pill of buttons, not a form fieldset. */}
      <div
        ref={pill}
        role="group"
        aria-label="Switch apps"
        data-testid="system-switcher"
        hidden={!controller.switcher}
        onKeyDown={(event) => {
          if (event.key === "Escape") setTip(undefined)
        }}
        className={`pointer-events-auto absolute flex touch-none items-center gap-0.5 rounded-full border border-border bg-overlay p-1 text-foreground shadow-overlay select-none ${
          dragging ? "cursor-grabbing [&_button]:cursor-grabbing" : "cursor-grab"
        }`}
      >
        {([-1, 1] as const).map((step) => {
          const name = step < 0 ? "previous" : "next"
          return [
            step > 0 ? <Separator key="separator" orientation="vertical" className="h-5" /> : null,
            <button
              key={name}
              ref={register(name)}
              type="button"
              className={ARROW}
              aria-label={step < 0 ? "Previous app" : "Next app"}
              aria-description={label(step)}
              data-tip={label(step)}
              data-testid={`system-switcher-${name}`}
              onClick={() => go(step)}
            >
              {step < 0 ? (
                <ArrowLeft className="size-4" aria-hidden="true" />
              ) : (
                <ArrowRight className="size-4" aria-hidden="true" />
              )}
            </button>,
          ]
        })}
        {build ? (
          <BuildDot
            build={build}
            register={register("dot")}
            onOpen={() => {
              if (!dragged.current) controller.show("system")
            }}
          />
        ) : null}
      </div>
      {build ? (
        <UpdateToast
          build={build}
          shell={shell}
          pill={pill}
          placeToast={placeToast}
          visiblePill={controller.switcher}
          focusDot={() => buttons.current.get("dot")?.focus()}
        />
      ) : null}
      <div
        ref={tipBox}
        role="tooltip"
        hidden={!tip}
        className="tooltip pointer-events-none absolute flex items-center gap-2 whitespace-nowrap text-foreground"
      >
        {tip === "dot" && dotStatus ? (
          <span aria-hidden="true" className={`size-2 rounded-full ${TONE_FILL[dotStatus.tone]}`} />
        ) : destination ? (
          <IconMark
            icon={
              destination.icon ?? (destination.id === "system" ? SYSTEM_ICONS.system : undefined)
            }
            label={destination.label}
            size="sm"
          />
        ) : null}
        {tipText}
      </div>
    </Layer>
  )
}

/** The dot's status, ticking each second while a countdown runs. */
function useDotStatus(build: SystemBuild | undefined) {
  const state = useMaybeBuildState(build)
  const ticking =
    !!state &&
    state.update.available &&
    !state.update.applying &&
    state.update.auto &&
    !!state.update.autoApplyAt
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  return state ? { ...buildStatus(state, Date.now()), state } : undefined
}

const NO_BUILD: SystemBuild = {
  get: () => undefined as never,
  subscribe: () => () => {},
  applyUpdate: async () => {},
  postpone: () => {},
  setAutoUpdate: () => {},
}
function useMaybeBuildState(build: SystemBuild | undefined) {
  const state = useBuildState(build ?? NO_BUILD)
  return build ? state : undefined
}

const DOT_RING: Record<string, string> = {
  ok: "",
  building:
    "absolute inset-0 rounded-full border-2 border-warning border-r-transparent border-b-transparent motion-safe:animate-spin",
  ready: "absolute inset-px rounded-full border border-accent opacity-70",
  failed: "",
  offline: "",
}

/** On the pill's corner, without changing its size: what this preview's build is doing. */
function BuildDot({
  build,
  register,
  onOpen,
}: {
  build: SystemBuild
  register: (node: HTMLButtonElement | null) => void
  onOpen(): void
}) {
  const status = useDotStatus(build)
  if (!status) return null
  const live = status.state.connection === "live"
  return (
    <button
      ref={register}
      type="button"
      data-testid="system-build-dot"
      data-tone={status.tone}
      data-live={String(live)}
      aria-label={`Preview status: ${status.text}`}
      onClick={onOpen}
      className="group absolute -top-1.5 -right-1.5 size-5 cursor-pointer rounded-full p-0 outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
    >
      <span
        aria-hidden="true"
        className={`absolute inset-1 rounded-full ring-2 ring-overlay transition-shadow group-hover:ring-4 ${
          status.tone === "offline" ? "border-2 border-muted bg-overlay" : TONE_FILL[status.tone]
        }`}
      />
      {status.tone === "ok" && live ? (
        <span
          aria-hidden="true"
          className="absolute inset-1 rounded-full bg-success opacity-60 motion-safe:animate-ping"
        />
      ) : null}
      {DOT_RING[status.tone] ? <span aria-hidden="true" className={DOT_RING[status.tone]} /> : null}
    </button>
  )
}

/** Beside the pill (never over it) while an update is ready, applying, or failed. */
function UpdateToast({
  build,
  shell,
  pill,
  placeToast,
  visiblePill,
  focusDot,
}: {
  build: SystemBuild
  shell: HTMLElement
  pill: { current: HTMLDivElement | null }
  placeToast: { current: () => void }
  visiblePill: boolean
  focusDot(): void
}) {
  const state = useBuildState(build)
  const toast = useRef<HTMLDivElement>(null)
  const [dismissed, setDismissed] = useState<string>()
  const [, setTick] = useState(0)
  const next = nextVersion(state)
  const { update } = state
  const showing =
    update.available && (update.applying || update.error !== undefined || next !== dismissed)
  const ticking = update.available && !update.applying && update.auto && !!update.autoApplyAt
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [ticking])

  /** Beside the pill on the side with room, else below or above it; never over it. */
  const place = useCallback(() => {
    const node = toast.current
    if (!node || node.hidden) return
    const GAP = 10
    const EDGE = 8
    const width = shell.clientWidth
    const height = shell.clientHeight
    node.style.maxWidth = `${Math.max(160, Math.min(380, width - EDGE * 2))}px`
    const box = shell.getBoundingClientRect()
    const rect = pill.current?.getBoundingClientRect()
    const edges =
      !visiblePill || !rect
        ? { left: EDGE, right: EDGE, top: height - EDGE, bottom: height - EDGE }
        : {
            left: rect.left - box.left,
            right: rect.right - box.left,
            top: rect.top - box.top,
            bottom: rect.bottom - box.top,
          }
    const w = node.offsetWidth
    const h = node.offsetHeight
    const middleY = (edges.top + edges.bottom) / 2 - h / 2
    const middleX = (edges.left + edges.right) / 2 - w / 2
    const clampX = (value: number) => Math.max(EDGE, Math.min(value, width - w - EDGE))
    const clampY = (value: number) => Math.max(EDGE, Math.min(value, height - h - EDGE))
    const candidates = {
      right: {
        x: edges.right + GAP,
        y: clampY(middleY),
        fits: edges.right + GAP + w <= width - EDGE,
      },
      left: { x: edges.left - GAP - w, y: clampY(middleY), fits: edges.left - GAP - w >= EDGE },
      below: {
        x: clampX(middleX),
        y: edges.bottom + GAP,
        fits: edges.bottom + GAP + h <= height - EDGE,
      },
      above: { x: clampX(middleX), y: edges.top - GAP - h, fits: edges.top - GAP - h >= EDGE },
    }
    // Facing into the page first: right of a pill on the left edge, above one at the bottom.
    const roomRight = width - edges.right
    const roomBelow = height - edges.bottom
    const horizontal =
      roomRight >= edges.left ? (["right", "left"] as const) : (["left", "right"] as const)
    const vertical =
      roomBelow >= edges.top ? (["below", "above"] as const) : (["above", "below"] as const)
    const sideways = Math.min(edges.left, roomRight) <= Math.min(edges.top, roomBelow)
    const order = sideways ? [...horizontal, ...vertical] : [...vertical, ...horizontal]
    const side = order.find((name) => candidates[name].fits) ?? vertical[0]
    const chosen = candidates[side]
    node.dataset.side = side
    node.style.left = `${chosen.x}px`
    node.style.top = `${chosen.y}px`
  }, [shell, pill, visiblePill])
  placeToast.current = place
  useLayoutEffect(() => place())

  // Leave focus somewhere sensible rather than on a hidden button.
  const wasShowing = useRef(showing)
  useLayoutEffect(() => {
    const node = toast.current
    const root = node?.ownerDocument
    if (wasShowing.current && !showing && node && root && node.contains(root.activeElement))
      focusDot()
    wasShowing.current = showing
  }, [showing, focusDot])

  const later = () => {
    setDismissed(nextVersion(build.get()))
    build.postpone()
  }
  const apply = () => {
    void build.applyUpdate().catch(() => {
      /* The source reports a failure through `update.error`. */
    })
  }
  const target = shortSha(next ?? "")
  const mode = update.applying ? "applying" : update.error ? "error" : "ready"

  return (
    <Card
      ref={toast}
      role="status"
      data-testid="system-update-toast"
      data-mode={mode}
      hidden={!showing}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !update.applying) later()
      }}
      className="pointer-events-auto absolute w-max flex-row flex-wrap items-center gap-x-3 gap-y-2 py-2.5 pr-2.5 pl-3.5 text-sm shadow-overlay motion-safe:animate-in motion-safe:zoom-in-95"
    >
      {mode === "applying" ? (
        <Spinner size="sm" aria-hidden="true" />
      ) : (
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full ring-4 ${
            mode === "error" ? "bg-danger ring-danger-soft" : "bg-accent ring-accent-soft"
          }`}
        />
      )}
      <p className="m-0 min-w-0 flex-[1_1_160px] text-muted">
        {mode === "applying" ? (
          "Updating…"
        ) : mode === "error" ? (
          <>
            <strong className="font-semibold text-foreground">Couldn't update to {target}.</strong>{" "}
            {update.error}
          </>
        ) : (
          <>
            <strong className="font-semibold text-foreground">New version {target} ready</strong>
            {update.auto && update.autoApplyAt ? (
              <span className="tabular-nums">
                {" "}
                · updating in {secondsUntil(update.autoApplyAt, Date.now())}s
              </span>
            ) : null}
          </>
        )}
      </p>
      {mode === "applying" ? null : (
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" onPress={later}>
            Not now
          </Button>
          <Button size="sm" onPress={apply}>
            {mode === "error" ? "Retry" : "Update now"}
          </Button>
        </div>
      )}
    </Card>
  )
}
