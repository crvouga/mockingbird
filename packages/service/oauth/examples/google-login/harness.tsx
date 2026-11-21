/**
 * The example's browser shell: the toolbar (provider profile, its behaviour, the flow, the
 * appearance, account selection), the virtual address bar, the app's surface, the provider's
 * popup (a real window, or a dialog over the example when popups are blocked) and the request
 * trace. Every page either side serves is the real response HTML, pasted into a shadow tree.
 */
import { Brand, MockingbirdProvider, type MockingbirdTheme } from "@crvouga/mockingbird-ui/react"
import { renderPage } from "@crvouga/mockingbird-ui/react/server"
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import { Button, Card, CloseButton, Disclosure, Label, ListBox, Select } from "@heroui/react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import type { BehaviorInput } from "../../src/index.js"
import { APP, createExample, type ExampleProvider, IDENTITY, type Trace } from "./app.js"
import { pasteDocument } from "./paste.js"
import { createBrowser } from "./transport.js"

export type ExampleOptions = {
  flow?: "popup" | "redirect"
  theme?: MockingbirdTheme
  reuseLastAccount?: boolean
  /** The provider profile to start with. Default "google". */
  provider?: ExampleProvider
}

type Flow = "popup" | "redirect"

const PROFILES: [ExampleProvider, string][] = [
  ["google", "Google-style OIDC"],
  ["apple", "Apple-style OIDC"],
  ["microsoft", "Microsoft-style OIDC"],
  ["github", "GitHub-style OAuth"],
]

const BEHAVIORS: Record<ExampleProvider, [string, string][]> = {
  google: [
    ["normal", "Normal sign-in"],
    ["missing_email", "Email claim omitted"],
    ["missing_name", "Profile name omitted"],
    ["unverified_email", "Email not verified"],
    ["consent_denied", "Consent declined"],
    ["unavailable", "Token endpoint unavailable"],
  ],
  apple: [
    ["normal", "Ask whether to share email"],
    ["apple_private_relay", "Always hide email"],
    ["apple_share_email", "Always share email"],
    ["apple_returning_user", "Returning user (no profile payload)"],
    ["apple_boolean_claims", "Boolean privacy claims"],
    ["missing_email", "Email claim omitted"],
    ["missing_name", "Name omitted"],
    ["consent_denied", "Consent declined"],
    ["unavailable", "Token endpoint unavailable"],
  ],
  microsoft: [
    ["normal", "Normal sign-in"],
    ["microsoft_missing_email", "Email claim omitted"],
    ["missing_name", "Display name omitted"],
    ["microsoft_spa_expiry", "24-hour refresh lifetime"],
    ["consent_denied", "Consent declined"],
    ["unavailable", "Token endpoint unavailable"],
  ],
  github: [
    ["normal", "Private email list fallback"],
    ["github_unverified_email", "Unverified primary email"],
    ["missing_email", "No usable email"],
    ["missing_name", "Profile name omitted"],
    ["consent_denied", "Authorization declined"],
    ["unavailable", "Token endpoint unavailable"],
  ],
}

const POPUP_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'"

/** A labelled HeroUI Select over string options, its list rendered inside the example. */
function Choice<T extends string>(props: {
  label: string
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
  portal: Element | null
  testId: string
}) {
  return (
    <Select
      className="w-full min-w-44 sm:w-auto"
      value={props.value}
      onChange={(value) => {
        if (typeof value === "string") props.onChange(value as T)
      }}
      data-testid={props.testId}
    >
      <Label>{props.label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover {...(props.portal ? { UNSTABLE_portalContainer: props.portal } : {})}>
        <ListBox>
          {props.options.map(([value, label]) => (
            <ListBox.Item key={value} id={value} textValue={label}>
              {label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}

/** The chrome of the provider's window, for the popup's own document. */
function PopupChrome() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <ProviderBar address={<span data-provider-address>{new URL(IDENTITY).host}</span>} />
      <p className="px-4 py-3 text-sm text-muted" role="status" data-provider-status>
        Connecting to the identity provider…
      </p>
      <div className="min-h-0 flex-1 overflow-auto" data-provider-mount />
    </div>
  )
}

function ProviderBar(props: { address: ReactNode; onClose?: () => void }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div className="flex min-w-0 flex-col">
        <Brand product="OAuth" size={20} className="text-sm" />
        <span className="truncate font-mono text-xs text-muted">{props.address}</span>
      </div>
      <CloseButton
        aria-label="Close sign-in popup"
        data-provider-close
        {...(props.onClose ? { onPress: props.onClose } : {})}
      />
    </div>
  )
}

type View = {
  status: string
  address: string
  entries: Trace[]
  dialog: boolean
  providerAddress: string
  providerStatus: string | null
}

export function Example({ options }: { options: ExampleOptions }) {
  const [profile, setProfile] = useState<ExampleProvider>(options.provider ?? "google")
  const [behavior, setBehavior] = useState("normal")
  const [flow, setFlow] = useState<Flow>(options.flow ?? "popup")
  const [appearance, setAppearance] = useState<MockingbirdTheme>(options.theme ?? "system")
  const [reuse, setReuse] = useState(options.reuseLastAccount ?? false)
  const [resetCount, setResetCount] = useState(0)
  const [portal, setPortal] = useState<HTMLElement | null>(null)
  const [view, setView] = useState<View>({
    status: "Starting the app…",
    address: "",
    entries: [],
    dialog: false,
    providerAddress: new URL(IDENTITY).host,
    providerStatus: "Connecting to the identity provider…",
  })
  const frame = useRef<HTMLElement>(null)
  const dialogFrame = useRef<HTMLElement>(null)
  // What the imperative browser reads at the moment it acts, without re-creating it.
  const live = useRef({ flow, appearance, reuse })
  live.current = { flow, appearance, reuse }
  const controller = useRef<ReturnType<typeof createController> | null>(null)

  // Behaviors are per profile: keep the choice when the new profile has it.
  const behaviors = BEHAVIORS[profile]
  const activeBehavior = behaviors.some(([value]) => value === behavior) ? behavior : "normal"

  // A new example (provider, behaviour, reset) every time one of those changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetCount is the reset trigger
  useEffect(() => {
    if (!frame.current || !dialogFrame.current) return
    const instance = createController({
      frame: frame.current,
      dialogFrame: dialogFrame.current,
      live,
      setView,
      profile,
      behavior: activeBehavior,
    })
    controller.current = instance
    return () => {
      instance.dispose()
      controller.current = null
    }
  }, [profile, activeBehavior, resetCount])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the controller reads the appearance itself
  useEffect(() => controller.current?.syncTheme(), [appearance])
  useEffect(() => controller.current?.setReuse(reuse), [reuse])

  const shellInert = view.dialog
  return (
    <MockingbirdProvider theme={appearance} className="relative text-sm">
      <Card className="overflow-hidden p-0" inert={shellInert}>
        <div className="flex flex-wrap items-end gap-3 p-4">
          <Choice
            label="Provider profile"
            value={profile}
            options={PROFILES}
            onChange={setProfile}
            portal={portal}
            testId="example-profile"
          />
          <Choice
            label="Provider behavior"
            value={activeBehavior}
            options={behaviors}
            onChange={setBehavior}
            portal={portal}
            testId="example-behavior"
          />
          <Choice
            label="Sign-in flow"
            value={flow}
            options={[
              ["popup", "Popup"],
              ["redirect", "Redirect"],
            ]}
            onChange={(next) => {
              setFlow(next)
              live.current = { ...live.current, flow: next }
              controller.current?.restart()
            }}
            portal={portal}
            testId="example-flow"
          />
          <Choice
            label="Appearance"
            value={appearance}
            options={[
              ["system", "System"],
              ["light", "Light"],
              ["dark", "Dark"],
            ]}
            onChange={setAppearance}
            portal={portal}
            testId="example-appearance"
          />
          <Choice
            label="Account selection"
            value={reuse ? "reuse" : "choose"}
            options={[
              ["choose", "Always choose"],
              ["reuse", "Reuse last account"],
            ]}
            onChange={(next) => setReuse(next === "reuse")}
            portal={portal}
            testId="example-account-selection"
          />
          <Button
            variant="secondary"
            onPress={() => setResetCount((count) => count + 1)}
            data-testid="example-reset"
          >
            Reset example
          </Button>
        </div>
        <div className="flex flex-wrap justify-between gap-2 border-t border-border px-4 py-2 text-xs">
          <span className="font-medium text-foreground">App → OAuth Emulator</span>
          <span className="text-muted">In process · no network</span>
        </div>
        <p
          className="border-t border-border bg-surface-secondary px-4 py-2 font-mono text-xs break-all text-muted"
          data-testid="example-address"
        >
          <span className="sr-only">Virtual browser address: </span>
          {view.address}
        </p>
        <section
          ref={frame}
          className="app-frame block h-[750px] overflow-auto border-t border-border sm:h-[700px]"
          aria-label="Example app"
        />
        <p
          className="border-t border-border px-4 py-2 text-xs text-muted"
          role="status"
          aria-live="polite"
          data-testid="example-status"
        >
          {view.status}
        </p>
        <Disclosure className="border-t border-border px-4 py-2">
          <Disclosure.Heading>
            <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 py-1 text-sm font-medium">
              {`Request trace (${view.entries.length})`}
              <Disclosure.Indicator />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body>
              <p className="pb-2 text-xs text-muted">
                Real Request / Response objects. Credentials and query strings are omitted.
              </p>
              <ol className="max-h-64 overflow-auto font-mono text-xs" data-testid="example-trace">
                {view.entries.map((entry) => (
                  <li
                    key={entry.sequence}
                    className="border-b border-border py-1.5 break-all last:border-b-0"
                  >
                    <span className="inline-block min-w-24 font-semibold text-foreground">
                      {entry.actor}
                    </span>{" "}
                    <span className="text-muted">{`${entry.method} ${entry.url} → ${entry.status}`}</span>
                  </li>
                ))}
              </ol>
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>
      </Card>
      <div
        className="fixed inset-0 z-10 grid place-items-center bg-[var(--backdrop)] p-4"
        hidden={!view.dialog}
      >
        {/* Modal to the example, not to the page: the layer covers only this example's own box
            (its host's containing block when embedded), and the app behind it is inert while it
            is open: the same rules as showModal(), scoped. */}
        <Card
          role="dialog"
          aria-modal="true"
          aria-label="OAuth Emulator sign-in"
          className="flex h-[min(820px,100%)] w-[min(540px,100%)] flex-col overflow-hidden p-0 shadow-xl"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return
            // Claimed, so an embedding modal treats this close request as handled.
            event.preventDefault()
            controller.current?.cancelProvider()
          }}
        >
          <ProviderBar
            address={view.providerAddress}
            onClose={() => controller.current?.cancelProvider()}
          />
          {view.providerStatus ? (
            <p className="px-4 py-3 text-sm text-muted" role="status">
              {view.providerStatus}
            </p>
          ) : null}
          <section
            ref={dialogFrame}
            className="min-h-0 flex-1 overflow-auto"
            aria-label="OAuth Emulator account selection and consent"
          />
        </Card>
      </div>
      <div ref={setPortal} />
    </MockingbirdProvider>
  )
}

type ControllerInput = {
  frame: HTMLElement
  dialogFrame: HTMLElement
  live: { current: { flow: Flow; appearance: MockingbirdTheme; reuse: boolean } }
  setView: (update: (view: View) => View) => void
  profile: ExampleProvider
  behavior: string
}

/**
 * The virtual browser: navigates, follows redirects, pastes each response into the surface it
 * belongs to (the app, or the provider's popup or dialog), and turns the pasted pages' clicks and
 * submits back into navigations. One per example; a reset disposes it and starts another.
 */
function createController(input: ControllerInput) {
  const { frame, dialogFrame, live, setView } = input
  const update = (patch: Partial<View>) => setView((view) => ({ ...view, ...patch }))
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
  let popup: Window | null = null
  let popupTimer: ReturnType<typeof setInterval> | undefined
  let popupAddress: HTMLElement | null = null
  let popupStatus: HTMLElement | null = null
  let dialogOpen = false
  let providerFrame: HTMLElement = dialogFrame
  const frameUrls = new WeakMap<HTMLElement, string>()
  const surfaceLoads = new WeakMap<HTMLElement, AbortController>()
  let navigation = 0
  let disposed = false
  let busy = false
  let entries: Trace[] = []

  const behavior: BehaviorInput =
    input.behavior === "unavailable"
      ? { probabilities: { tokenUnavailable: 1 } }
      : input.behavior === "normal"
        ? {}
        : { preset: input.behavior as Exclude<BehaviorInput["preset"], undefined> }
  const example = createExample(
    behavior,
    (entry) => {
      if (disposed) return
      entries = [...entries, entry].sort((a, b) => a.sequence - b.sequence).slice(-100)
      update({ entries })
    },
    input.profile,
  )
  example.preferences.reuseLastAccount = live.current.reuse
  const browser = createBrowser(example.dispatch)

  const colorScheme = () =>
    live.current.appearance === "system"
      ? systemTheme.matches
        ? "dark"
        : "light"
      : live.current.appearance
  function applyDocumentTheme(page: HTMLElement) {
    page.style.colorScheme = colorScheme()
    page.dataset.theme = live.current.appearance
  }
  function syncTheme() {
    for (const target of new Set([frame, dialogFrame, providerFrame])) {
      target.style.colorScheme = colorScheme()
      const page = target.shadowRoot?.querySelector<HTMLElement>(".page")
      if (page) applyDocumentTheme(page)
    }
    if (popup && !popup.closed) {
      const root = popup.document.documentElement
      root.style.colorScheme = colorScheme()
      if (live.current.appearance === "system") delete root.dataset.theme
      else root.dataset.theme = live.current.appearance
    }
  }
  function focusApp() {
    const doc = frame.shadowRoot
    const target =
      doc?.querySelector<HTMLElement>('a[href="/auth/start"]') ??
      doc?.querySelector<HTMLElement>("h1")
    if (target) {
      if (target.tagName === "H1") target.tabIndex = -1
      target.focus({ preventScroll: true })
    }
  }
  function clearSurface(target: HTMLElement) {
    surfaceLoads.get(target)?.abort()
    target.shadowRoot?.replaceChildren()
    frameUrls.delete(target)
  }
  function closeProvider() {
    if (popupTimer) clearInterval(popupTimer)
    popupTimer = undefined
    if (providerFrame !== dialogFrame) clearSurface(providerFrame)
    clearSurface(dialogFrame)
    popup?.close()
    popup = null
    popupAddress = null
    popupStatus = null
    if (dialogOpen) update({ dialog: false })
    dialogOpen = false
    providerFrame = dialogFrame
  }
  function cancelProvider() {
    // Discard a response already in flight, so closing the popup cannot reopen it.
    navigation++
    busy = false
    closeProvider()
    update({ status: "Sign-in window closed. You can try again." })
    focusApp()
  }
  function openProvider() {
    // Called synchronously from the app's click, to keep the popup's user activation.
    if (popup && !popup.closed) {
      popup.focus()
      return
    }
    if (dialogOpen) return
    try {
      popup = window.open("about:blank", "", "popup,width=540,height=820")
    } catch {
      popup = null
    }
    if (popup) {
      try {
        popup.document.open()
        popup.document.write(
          renderPage(<PopupChrome />, {
            title: "Sign in · OAuth",
            css: MOCKINGBIRD_CSS,
            head: `<meta http-equiv="Content-Security-Policy" content="${POPUP_POLICY}">`,
          }),
        )
        popup.document.close()
        const child = popup.document.querySelector<HTMLElement>("[data-provider-mount]")
        popupAddress = popup.document.querySelector<HTMLElement>("[data-provider-address]")
        popupStatus = popup.document.querySelector<HTMLElement>("[data-provider-status]")
        if (!child || !popupAddress || !popupStatus) throw new Error("Popup unavailable")
        providerFrame = child
        popup.document
          .querySelector("[data-provider-close]")
          ?.addEventListener("click", cancelProvider)
        popup.document.addEventListener("keydown", (event) => {
          if (event.key === "Escape") cancelProvider()
        })
        syncTheme()
        popupTimer = setInterval(() => {
          if (popup?.closed) cancelProvider()
        }, 250)
        return
      } catch {
        popup.close()
        popup = null
      }
    }
    providerFrame = dialogFrame
    dialogOpen = true
    update({
      dialog: true,
      providerStatus: "Connecting to the identity provider…",
      providerAddress: new URL(IDENTITY).host,
    })
  }
  function render(target: HTMLElement, url: string, html: string) {
    // Each surface gets the real response HTML, pasted in place. Embedded browsers reject
    // iframes, and the host bridges the theme because the page's own script is omitted.
    surfaceLoads.get(target)?.abort()
    const page = pasteDocument(target, html)
    applyDocumentTheme(page)
    target.style.colorScheme = colorScheme()
    frameUrls.set(target, url)
    const step = navigation
    queueMicrotask(() => {
      if (disposed || step !== navigation || frameUrls.get(target) !== url) return
      loaded(target)
    })
  }
  async function navigate(url: string, init: Parameters<typeof browser.navigate>[1] = {}) {
    if (busy || disposed) return
    const step = ++navigation
    busy = true
    update({
      status:
        live.current.flow === "popup"
          ? "Waiting for sign-in in the provider window…"
          : "Redirecting…",
    })
    try {
      const result = await browser.navigate(url, init)
      const html = await result.response.text()
      if (step !== navigation || disposed) return
      const location = new URL(result.url)
      if (location.origin === APP) {
        closeProvider()
        render(frame, result.url, html)
        update({
          address: `${location.host}${location.pathname}`,
          status: result.response.ok
            ? live.current.flow === "popup"
              ? "App ready. Sign-in opens a separate provider window."
              : "App ready. Sign-in redirects to the provider and back."
            : "Sign-in did not complete. You’re back in the app and can try again.",
        })
      } else if (location.origin === IDENTITY) {
        const address = `${location.host}${location.pathname}`
        if (live.current.flow === "redirect") {
          render(frame, result.url, html)
          update({
            address,
            status:
              "Redirected to OAuth Emulator. Complete or cancel sign-in to return to the app.",
          })
          return
        }
        if (!popup && !dialogOpen) throw new Error("The sign-in window was closed")
        if (popupAddress && popupStatus) {
          popupAddress.textContent = address
          popupStatus.hidden = true
        } else update({ providerAddress: address, providerStatus: null })
        render(providerFrame, result.url, html)
        update({
          status: "Complete sign-in in the separate provider window. The app stays open here.",
        })
      }
    } catch (error) {
      if (step === navigation && !disposed) {
        closeProvider()
        update({
          status: `Unable to continue: ${error instanceof Error ? error.message : "Unknown error"}. Try signing in again.`,
        })
        focusApp()
      }
    } finally {
      if (step === navigation) busy = false
    }
  }
  function loaded(target: HTMLElement) {
    if (disposed) return
    const doc = target.shadowRoot
    const currentUrl = frameUrls.get(target)
    if (!doc || !currentUrl || !doc.querySelector("[data-mockingbird-root]")) return
    // A closed popup's delayed paint must never steal focus or submit another request.
    if (target !== frame && !popup && !dialogOpen) return
    surfaceLoads.get(target)?.abort()
    const controller = new AbortController()
    surfaceLoads.set(target, controller)
    const signal = controller.signal
    doc.addEventListener(
      "submit",
      (event) => {
        event.preventDefault()
        const form = event.target as HTMLFormElement
        const data = new FormData(form, (event as SubmitEvent).submitter)
        const params = new URLSearchParams()
        for (const [name, value] of data) if (typeof value === "string") params.append(name, value)
        const url = new URL(form.getAttribute("action") ?? currentUrl, currentUrl)
        const method = (form.getAttribute("method") ?? "GET").toUpperCase()
        if (method === "GET") url.search = params.toString()
        void navigate(url.href, {
          method,
          ...(method === "GET" ? {} : { body: params }),
          origin: new URL(currentUrl).origin,
        })
      },
      { capture: true, signal },
    )
    doc.addEventListener(
      "click",
      (event) => {
        const link = (event.target as Element).closest?.("a[href]")
        if (!link) return
        event.preventDefault()
        const href = link.getAttribute("href") ?? ""
        if (href.startsWith("#")) {
          const anchor = doc.getElementById(href.slice(1))
          anchor?.focus()
          anchor?.scrollIntoView()
          return
        }
        const url = new URL(href, currentUrl)
        if (target === frame && url.origin === APP && url.pathname === "/auth/start") {
          if (busy) return
          if (live.current.flow === "popup") openProvider()
        }
        void navigate(url.href)
      },
      { capture: true, signal },
    )
    doc.addEventListener(
      "keydown",
      (event) => {
        if (!(event instanceof KeyboardEvent) || event.key !== "Escape" || target === frame) return
        event.preventDefault()
        event.stopPropagation()
        cancelProvider()
      },
      { signal },
    )
    const heading = doc.querySelector<HTMLElement>("h1")
    if (heading) {
      heading.tabIndex = -1
      // A focus target for screen readers after each navigation, not a control: no ring.
      heading.style.outline = "none"
      heading.focus({ preventScroll: true })
    }
    // Apple's response_mode=form_post page auto-submits in a real browser. Its script is
    // omitted with the rest of the document scripts, so the host submits that form itself.
    // Deferred until after navigate() releases `busy`, or this submit would be ignored.
    doc.querySelector<HTMLFormElement>("form#callback")?.requestSubmit()
  }

  systemTheme.addEventListener("change", syncTheme)
  void navigate(APP)
  return {
    syncTheme,
    cancelProvider,
    setReuse(reuse: boolean) {
      example.preferences.reuseLastAccount = reuse
    },
    /** A new flow: close any sign-in in progress and reload the app. */
    restart() {
      cancelProvider()
      void navigate(APP)
    },
    dispose() {
      disposed = true
      navigation++
      closeProvider()
      systemTheme.removeEventListener("change", syncTheme)
      clearSurface(frame)
    },
  }
}
