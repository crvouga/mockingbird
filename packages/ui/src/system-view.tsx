/**
 * The System harness's React view, loaded lazily by `system-harness.ts`. One React root draws the
 * switcher bar into the strip across the top of the shell, its tooltip, update toast and notice
 * into the harness's chrome layer below it, and portals each panel's loading or error state and the System screen into their own hosts.
 *
 * Mockingbird's stylesheet goes into the document once, scoped (`scope-css.ts`) to the `.msh-ui`
 * containers this view draws in, so Preflight and HeroUI's classes restyle nothing of the host
 * page or of the surfaces' own content. (Shadow roots would isolate further, but React Aria's
 * press handling, behind every HeroUI button and switch, does not work across a shadow boundary.)
 */
import { ArrowLeft, ArrowRight, Sliders, TriangleExclamation } from "@gravity-ui/icons"
import { Button, Card, Spinner } from "@heroui/react"
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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
import { SWITCHER_BAR_HEIGHT, stepRotation } from "./system-rotation.js"
import { SystemScreen } from "./system-screen.js"
import { notEmulated, type ServicesStore, trackServices } from "./system-services-store.js"
import {
  matchesShortcut,
  parseShortcut,
  type Shortcut,
  shortcutKeys,
  startsShortcut,
} from "./system-shortcut.js"
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

// ---- Theme: the host page's pinned light or dark (`class` / `data-theme` on <html>), else the
// background the harness actually sits on, else the system's.

const pinned = (doc: Document): MockingbirdTheme => {
  const root = doc.documentElement
  const theme = root.dataset.theme
  if (theme === "light" || theme === "dark") return theme
  if (root.classList.contains("dark")) return "dark"
  if (root.classList.contains("light")) return "light"
  return "system"
}

/**
 * Whether a computed `background-color` reads as dark; undefined when it paints nothing (or is in
 * a notation this does not read, which leaves the system's theme in charge).
 */
export function isDarkBackground(color: string): boolean | undefined {
  const match =
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(
      color.trim(),
    )
  if (!match) return undefined
  const alpha =
    match[4] === undefined
      ? 1
      : match[4].endsWith("%")
        ? Number.parseFloat(match[4]) / 100
        : Number(match[4])
  if (!(alpha >= 0.5)) return undefined
  const [red, green, blue] = [match[1], match[2], match[3]].map(Number) as [number, number, number]
  // Perceived lightness (Rec. 709 luma): close enough to tell a dark page from a light one.
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255 < 0.5
}

/** How the harness's own UI is themed, and whether its bar can sit on the host's background. */
export type HostTheme = {
  theme: MockingbirdTheme
  /**
   * True when the host page paints a background behind the harness and pins no theme: the bar
   * is then transparent over it, so it reads as part of that page whatever its colors are.
   */
  blend: boolean
}

/**
 * The theme for a harness in `shell`. A pin on <html> wins (Mockingbird's own switch sets one).
 * Otherwise the nearest ancestor that paints a background decides, so a dark app on a machine set
 * to light gets dark chrome, with no option to pass. A page that paints none gets the system's.
 */
export function hostTheme(shell: HTMLElement): HostTheme {
  const doc = shell.ownerDocument
  const pin = pinned(doc)
  if (pin !== "system") return { theme: pin, blend: false }
  const view = doc.defaultView
  for (let element = shell.parentElement; element && view; element = element.parentElement) {
    const dark = isDarkBackground(view.getComputedStyle(element).backgroundColor)
    if (dark !== undefined) return { theme: dark ? "dark" : "light", blend: true }
  }
  return { theme: "system", blend: false }
}

function useHostTheme(shell: HTMLElement): HostTheme {
  const doc = shell.ownerDocument
  const subscribe = useCallback(
    (listener: () => void) => {
      // A theme switch of the host's own: a class, an attribute or an inline style, on <html>,
      // <body> or the element the harness is mounted in.
      const observer = new MutationObserver(listener)
      const options = { attributes: true, attributeFilter: ["class", "data-theme", "style"] }
      for (const element of new Set([doc.documentElement, doc.body, shell.parentElement]))
        if (element) observer.observe(element, options)
      const media = doc.defaultView?.matchMedia?.("(prefers-color-scheme: dark)")
      media?.addEventListener("change", listener)
      return () => {
        observer.disconnect()
        media?.removeEventListener("change", listener)
      }
    },
    [doc, shell],
  )
  const key = useSyncExternalStore(subscribe, () => {
    const { theme, blend } = hostTheme(shell)
    return `${theme}${blend ? " blend" : ""}`
  })
  return useMemo(
    () => ({ theme: key.split(" ")[0] as MockingbirdTheme, blend: key.endsWith(" blend") }),
    [key],
  )
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
 * The theme on a layer drawn over the host's own background (the bar, a panel's status): what
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

/** A section the System screen should bring into view, numbered so the same one can repeat. */
export type SectionRequest = { id: string; count: number }

function Harness({ controller }: { controller: HarnessController }) {
  const snapshot = useSnapshot(controller)
  const { theme, blend } = useHostTheme(controller.shell)
  const store = useMemo(
    () => (controller.services ? trackServices(controller.services) : undefined),
    [controller.services],
  )
  const [request, setRequest] = useState<SectionRequest>()
  const openSystem = useCallback(
    (section?: string) => {
      if (section) setRequest((previous) => ({ id: section, count: (previous?.count ?? 0) + 1 }))
      controller.show("system")
    },
    [controller],
  )
  const apps = snapshot.order
    .map((id) => controller.apps.find((app) => app.id === id))
    .filter((app): app is SystemApp => app !== undefined)
  return (
    <>
      <Chrome
        controller={controller}
        snapshot={snapshot}
        theme={theme}
        blend={blend}
        store={store}
        openSystem={openSystem}
      />
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
              services={store?.services}
              docsUrl={controller.docsUrl}
              build={controller.build}
              backends={controller.backends}
              sections={controller.sections}
              snapshot={controller.snapshot}
              syncUrl={controller.syncUrl}
              request={request}
            />
          </div>
        </Portal>
      ) : null}
    </>
  )
}

// ---- The switcher bar: a thin strip across the top with arrows through the rotation.

type Tip = "previous" | "next" | "dot" | "dev" | "system"

/**
 * A control in the bar: an icon and no words, faint until hovered or focused, so the strip stays
 * out of the way of the app under it.
 */
const BAR_BUTTON =
  "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded p-0 text-muted opacity-60 outline-offset-1 hover:bg-default hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-focus"

/** How long the shortcuts' modifiers are held before the bar shows what each shortcut does. */
const HINT_DELAY_MS = 350

const isMac = (doc: Document) => /Mac|iPhone|iPad/.test(doc.defaultView?.navigator.platform ?? "")

/** A shortcut drawn as key caps. Read out through `aria-keyshortcuts`, so hidden here. */
function Keys({ shortcut, mac }: { shortcut: Shortcut; mac: boolean }) {
  return (
    <span aria-hidden="true" data-shortcut="" className="inline-flex items-center gap-0.5">
      {shortcutKeys(shortcut, mac).map((key) => (
        <kbd
          key={key}
          className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-surface-secondary px-1 font-sans text-[10px] leading-none text-muted"
        >
          {key}
        </kbd>
      ))}
    </span>
  )
}

/** The services not emulated, kept current: the bar's dev badge. */
function useNotEmulated(store: ServicesStore | undefined) {
  const subscribe = useCallback(
    (listener: () => void) => store?.watch(listener) ?? (() => {}),
    [store],
  )
  useEffect(() => {
    void store?.refresh().catch(() => {
      /* The System screen shows why the services could not be listed. */
    })
  }, [store])
  const latest = useStore(subscribe, () => store?.latest())
  return notEmulated(latest)
}

function Chrome({
  controller,
  snapshot,
  theme,
  blend,
  store,
  openSystem,
}: {
  controller: HarnessController
  snapshot: HarnessSnapshot
  theme: MockingbirdTheme
  /** The bar sits on the host page's own background instead of painting Mockingbird's. */
  blend: boolean
  store: ServicesStore | undefined
  openSystem(section?: string): void
}) {
  const { shell, build } = controller
  const tipBox = useRef<HTMLDivElement>(null)
  const buttons = useRef(new Map<Tip, HTMLButtonElement>())
  const [tip, setTip] = useState<Tip>()
  const openRef = useRef(() => openSystem())
  openRef.current = () => openSystem()

  const appOf = (id: string) =>
    controller.apps.find((app) => app.id === id) ?? (controller.apps[0] as SystemApp)
  const neighbour = (step: -1 | 1) =>
    appOf(stepRotation(snapshot.order, snapshot.excluded, snapshot.current, step))
  const label = (step: -1 | 1) => `${step < 0 ? "Previous" : "Next"}: ${neighbour(step).label}`
  const current = controller.apps.find((app) => app.id === snapshot.current)

  // The keyboard shortcuts, from anywhere in the page: open System, and step through the rotation.
  const { systemShortcut, switchShortcuts } = controller
  const stepKeys = controller.switcher && switchShortcuts ? switchShortcuts : undefined
  const shortcuts = useMemo(
    () => ({
      system: systemShortcut ? parseShortcut(systemShortcut) : undefined,
      previous: stepKeys ? parseShortcut(stepKeys.previous) : undefined,
      next: stepKeys ? parseShortcut(stepKeys.next) : undefined,
    }),
    [systemShortcut, stepKeys],
  )
  const mac = isMac(shell.ownerDocument)
  const stepRef = useRef((_step: -1 | 1) => {})
  stepRef.current = (step) => controller.show(neighbour(step).id)
  // While the shortcuts' modifiers are held, the bar says what each shortcut does.
  const [hints, setHints] = useState(false)
  useEffect(() => {
    const all = [shortcuts.system, shortcuts.previous, shortcuts.next].filter(
      (shortcut): shortcut is Shortcut => !!shortcut,
    )
    if (all.length === 0) return
    const doc = shell.ownerDocument
    const view = doc.defaultView
    let timer: ReturnType<typeof setTimeout> | undefined
    const hide = () => {
      clearTimeout(timer)
      timer = undefined
      setHints(false)
    }
    const held = (event: KeyboardEvent) => {
      if (!startsShortcut(event, all)) return hide()
      timer ??= setTimeout(() => setHints(true), HINT_DELAY_MS)
    }
    const press = (event: KeyboardEvent) => {
      held(event)
      if (event.defaultPrevented) return
      const run =
        shortcuts.system && matchesShortcut(event, shortcuts.system)
          ? () => openRef.current()
          : shortcuts.previous && matchesShortcut(event, shortcuts.previous)
            ? () => stepRef.current(-1)
            : shortcuts.next && matchesShortcut(event, shortcuts.next)
              ? () => stepRef.current(1)
              : undefined
      if (!run) return
      event.preventDefault()
      run()
    }
    doc.addEventListener("keydown", press)
    doc.addEventListener("keyup", held)
    view?.addEventListener("blur", hide)
    return () => {
      hide()
      doc.removeEventListener("keydown", press)
      doc.removeEventListener("keyup", held)
      view?.removeEventListener("blur", hide)
    }
  }, [shortcuts, shell])

  const dev = useNotEmulated(store)
  const devText =
    dev.length === 0
      ? undefined
      : dev.length === 1
        ? `${dev[0]?.label} is not emulated: it uses its dev resource`
        : `${dev.length} services are not emulated: ${dev.map((service) => service.label).join(", ")}`
  const shortcutText = controller.systemShortcut
    ? `Press ${controller.systemShortcut} to open System.`
    : ""
  const description = `${devText ? `${devText}. ` : ""}${shortcutText}`.trim()

  // Tooltips: hover with a mouse, or keyboard focus. Native listeners, so a synthetic
  // `pointerenter` reaches them as a real one does. Bound again when the dev badge comes or goes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the buttons change only with the badge.
  useEffect(() => {
    const cleanups: (() => void)[] = []
    for (const [name, button] of buttons.current) {
      const enter = (event: globalThis.PointerEvent) => {
        if (event.pointerType === "mouse") flushSync(() => setTip(name))
      }
      const leave = () => setTip((shown) => (shown === name ? undefined : shown))
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
  }, [devText !== undefined, build !== undefined])

  const register = (name: Tip) => (node: HTMLButtonElement | null) => {
    if (node) buttons.current.set(name, node)
    else buttons.current.delete(name)
  }

  const tipShortcut =
    tip === "previous" || tip === "next" || tip === "system" ? shortcuts[tip] : undefined
  const destination = tip === "previous" ? neighbour(-1) : tip === "next" ? neighbour(1) : undefined
  const dotStatus = useDotStatus(build)
  const tipText =
    tip === "dot"
      ? dotStatus?.text
      : tip === "dev"
        ? devText
        : tip === "system"
          ? "System"
          : tip
            ? label(tip === "previous" ? -1 : 1)
            : undefined

  // Just below the bar, centered on the button, kept inside the shell.
  // biome-ignore lint/correctness/useExhaustiveDependencies: placed whenever its text changes.
  useLayoutEffect(() => {
    const box = tipBox.current
    const target = tip ? buttons.current.get(tip) : undefined
    const layer = box?.offsetParent
    if (!box || !target || !layer) return
    const outer = layer.getBoundingClientRect()
    const rect = target.getBoundingClientRect()
    const left = rect.left - outer.left + (rect.width - box.offsetWidth) / 2
    box.style.left = `${Math.max(4, Math.min(left, layer.clientWidth - box.offsetWidth - 4))}px`
    box.style.top = "6px"
  }, [tip, tipText, tipShortcut])

  return (
    <>
      {
        // Always drawn, and hidden while there is no app to switch to (`setSurfaces` can add one).
        <Portal host={controller.bar} theme={theme} style="height:100%">
          {/* biome-ignore lint/a11y/useSemanticElements: a bar of buttons, not a form fieldset. */}
          <div
            role="group"
            aria-label={devText ? "Switch apps · not all services emulated" : "Switch apps"}
            {...(description ? { "aria-description": description } : {})}
            data-testid="system-switcher"
            data-dev={devText ? "" : undefined}
            hidden={!controller.switcher}
            onKeyDown={(event) => {
              if (event.key === "Escape") setTip(undefined)
            }}
            data-blend={blend ? "" : undefined}
            className={`flex items-center gap-0.5 border-b px-1.5 text-foreground select-none ${
              blend ? "bg-transparent" : "bg-background"
            } ${devText ? "border-warning" : "border-transparent"}`}
            style={{ height: SWITCHER_BAR_HEIGHT }}
          >
            {([-1, 1] as const).map((step) => {
              const name = step < 0 ? "previous" : "next"
              return (
                <button
                  key={name}
                  ref={register(name)}
                  type="button"
                  className={BAR_BUTTON}
                  aria-label={step < 0 ? "Previous app" : "Next app"}
                  aria-description={label(step)}
                  aria-keyshortcuts={stepKeys?.[name]}
                  data-tip={label(step)}
                  data-testid={`system-switcher-${name}`}
                  onClick={() => controller.show(neighbour(step).id)}
                >
                  {step < 0 ? (
                    <ArrowLeft className="size-3" aria-hidden="true" />
                  ) : (
                    <ArrowRight className="size-3" aria-hidden="true" />
                  )}
                </button>
              )
            })}
            {/* No words in the bar: the shown surface's name is for assistive technology only. */}
            <span data-testid="system-switcher-current" className="sr-only" aria-live="polite">
              {current?.label}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              {devText ? (
                // A shape as well as a color: a triangle while any service is not emulated.
                <button
                  ref={register("dev")}
                  type="button"
                  data-testid="system-dev-badge"
                  aria-label={`${devText}. Open System's services`}
                  onClick={() => openSystem("services")}
                  className={`${BAR_BUTTON} text-warning opacity-100`}
                >
                  <TriangleExclamation aria-hidden="true" className="size-3" />
                </button>
              ) : null}
              {build ? (
                <BuildDot
                  build={build}
                  register={register("dot")}
                  onOpen={() => controller.show("system")}
                />
              ) : null}
              <button
                ref={register("system")}
                type="button"
                aria-label="System"
                aria-keyshortcuts={systemShortcut || undefined}
                data-testid="system-switcher-system"
                aria-current={snapshot.current === "system" ? "page" : undefined}
                onClick={() => openSystem()}
                className={`${BAR_BUTTON} aria-[current=page]:text-foreground aria-[current=page]:opacity-100`}
              >
                <Sliders aria-hidden="true" className="size-3" />
              </button>
            </span>
          </div>
        </Portal>
      }
      <Layer theme={theme} className="pointer-events-none absolute inset-0">
        <Notice notice={snapshot.notice} dismiss={controller.dismissNotice} />
        {build ? (
          <UpdateToast build={build} focusDot={() => buttons.current.get("dot")?.focus()} />
        ) : null}
        <div
          ref={tipBox}
          role="tooltip"
          hidden={!tip || hints}
          className="tooltip pointer-events-none absolute flex items-center gap-2 whitespace-nowrap text-foreground"
        >
          {tip === "dev" ? (
            <TriangleExclamation aria-hidden="true" className="size-3.5 text-warning" />
          ) : tip === "dot" && dotStatus ? (
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${TONE_FILL[dotStatus.tone]}`}
            />
          ) : tip === "system" ? (
            <IconMark icon={SYSTEM_ICONS.system} label="System" size="sm" />
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
          {tipShortcut ? <Keys shortcut={tipShortcut} mac={mac} /> : null}
        </div>
        {hints ? (
          // The modifiers are held: every shortcut, under the control it presses.
          <div
            data-testid="system-shortcut-hints"
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-1 top-1.5 flex items-start justify-between gap-2 text-foreground"
          >
            <span
              className={`flex items-center gap-3 whitespace-nowrap ${stepKeys ? "tooltip" : ""}`}
            >
              {([-1, 1] as const).map((step) => {
                const shortcut = step < 0 ? shortcuts.previous : shortcuts.next
                return shortcut ? (
                  <span key={step} className="flex items-center gap-1.5">
                    {step < 0 ? (
                      <ArrowLeft className="size-3 text-muted" />
                    ) : (
                      <ArrowRight className="size-3 text-muted" />
                    )}
                    {neighbour(step).label}
                    <Keys shortcut={shortcut} mac={mac} />
                  </span>
                ) : null
              })}
            </span>
            {shortcuts.system ? (
              <span className="tooltip flex items-center gap-1.5 whitespace-nowrap">
                <Sliders className="size-3 text-muted" />
                System
                <Keys shortcut={shortcuts.system} mac={mac} />
              </span>
            ) : null}
          </div>
        ) : null}
      </Layer>
    </>
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
    "absolute inset-0.5 rounded-full border-2 border-warning border-r-transparent border-b-transparent motion-safe:animate-spin",
  ready: "absolute inset-[3px] rounded-full border border-accent opacity-70",
  failed: "",
  offline: "",
}

/** In the bar, a fixed size whatever it shows: what this preview's build is doing. */
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
      className="group relative size-5 shrink-0 cursor-pointer rounded-full p-0 outline-offset-1 focus-visible:outline-2 focus-visible:outline-focus"
    >
      <span
        aria-hidden="true"
        // Up to date is the quiet state: a small, faint dot. The others ask for attention.
        className={`absolute rounded-full transition group-hover:scale-125 group-hover:opacity-100 group-focus-visible:opacity-100 ${
          status.tone === "ok" ? "inset-[7px] opacity-60" : "inset-1.5"
        } ${
          status.tone === "offline" ? "border-2 border-muted bg-background" : TONE_FILL[status.tone]
        }`}
      />
      {DOT_RING[status.tone] ? <span aria-hidden="true" className={DOT_RING[status.tone]} /> : null}
    </button>
  )
}

/** How long an update may take to apply before the toast says "Updating…". */
export const APPLYING_TOAST_DELAY_MS = 400

/** Under the bar's right end (never over it) while an update is ready, applying, or failed. */
function UpdateToast({ build, focusDot }: { build: SystemBuild; focusDot(): void }) {
  const state = useBuildState(build)
  const toast = useRef<HTMLDivElement>(null)
  const [dismissed, setDismissed] = useState<string>()
  const [, setTick] = useState(0)
  const next = nextVersion(state)
  const { update } = state
  // An update that applies at once (a dev server's, or one in a background tab) and is done
  // within a moment says nothing: the toast is for a wait, a choice or a failure.
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!update.applying) return setSlow(false)
    const timer = setTimeout(() => setSlow(true), APPLYING_TOAST_DELAY_MS)
    return () => clearTimeout(timer)
  }, [update.applying])
  const wasShowing = useRef(false)
  const showing =
    update.available &&
    (update.error !== undefined ||
      (update.applying ? slow || wasShowing.current : next !== dismissed))
  // An update that resets the preview's data never counts down, whatever the source says.
  const resets = update.resetsData === true
  const ticking =
    update.available && !update.applying && update.auto && !!update.autoApplyAt && !resets
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [ticking])

  // Leave focus somewhere sensible rather than on a hidden button.
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
      data-resets-data={resets ? "true" : undefined}
      hidden={!showing}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !update.applying) later()
      }}
      className="pointer-events-auto absolute top-2 right-2 w-max max-w-[min(380px,calc(100%-1rem))] flex-row flex-wrap items-center gap-x-3 gap-y-2 py-2.5 pr-2.5 pl-3.5 text-sm shadow-overlay motion-safe:animate-in motion-safe:zoom-in-95"
    >
      {mode === "applying" ? (
        <Spinner size="sm" aria-hidden="true" />
      ) : (
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full ring-4 ${
            mode === "error"
              ? "bg-danger ring-danger-soft"
              : resets
                ? "bg-warning ring-warning-soft"
                : "bg-accent ring-accent-soft"
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
        ) : resets ? (
          <>
            <strong className="font-semibold text-foreground">
              New version {target} resets this preview's data
            </strong>{" "}
            · it waits for you; save on System first to keep it
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

const NOTICE_DOT: Record<"info" | "warning" | "error", string> = {
  info: "bg-accent ring-accent-soft",
  warning: "bg-warning ring-warning-soft",
  error: "bg-danger ring-danger-soft",
}

/** Over the apps, centered at the top: why an update needs a reload, or what failed. */
function Notice({ notice, dismiss }: { notice: HarnessSnapshot["notice"]; dismiss(): void }) {
  return (
    <Card
      role={notice?.tone === "error" ? "alert" : "status"}
      data-testid="system-notice"
      data-tone={notice?.tone}
      hidden={!notice}
      className="pointer-events-auto absolute top-3 left-1/2 w-max max-w-[min(40rem,calc(100%-2rem))] -translate-x-1/2 flex-row flex-wrap items-center gap-x-3 gap-y-2 py-2.5 pr-2.5 pl-3.5 text-sm shadow-overlay"
    >
      <span
        aria-hidden="true"
        className={`size-2 shrink-0 rounded-full ring-4 ${NOTICE_DOT[notice?.tone ?? "info"]}`}
      />
      <p className="m-0 min-w-0 flex-[1_1_240px] text-foreground">{notice?.text}</p>
      <div className="ml-auto flex gap-1.5">
        <Button size="sm" variant="ghost" onPress={dismiss}>
          Dismiss
        </Button>
        {notice?.action ? (
          <Button size="sm" onPress={notice.action.run}>
            {notice.action.label}
          </Button>
        ) : null}
      </div>
    </Card>
  )
}
