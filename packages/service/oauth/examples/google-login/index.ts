import type { BehaviorInput } from "../../src/index.js"
import { APP, createExample, type ExampleProvider, IDENTITY, type Trace } from "./app.js"
import { createBrowser } from "./transport.js"

const closeIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18"/></svg>`
const closeButtonStyle = `display:grid;place-items:center;flex:0 0 36px;width:36px;height:36px;padding:0;border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;cursor:pointer;appearance:none`

export type ExampleOptions = {
  flow?: "popup" | "redirect"
  theme?: "system" | "light" | "dark"
  reuseLastAccount?: boolean
}

/** The only DOM-dependent layer: mount the portable application in any browser host. */
export async function mount(host: HTMLElement, options: ExampleOptions = {}) {
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" })
  root.innerHTML = `<style>
  :host{display:block;color:var(--fg,#242c29);font:14px/1.5 system-ui,sans-serif}*{box-sizing:border-box}.shell{border:1px solid var(--border,#d6ddd8);border-radius:14px;overflow:hidden;background:var(--bg,#fff)}.toolbar{display:flex;gap:16px;align-items:end;justify-content:space-between;padding:18px;flex-wrap:wrap}label{display:grid;gap:5px;font-size:12px;font-weight:600}select,button{font:inherit;color:inherit;background:var(--bg,#fff);border:1px solid var(--border,#c8d0ca);border-radius:7px;padding:9px 12px}button{cursor:pointer}button:hover{border-color:currentColor}:focus-visible{outline:3px solid var(--accent,#268462);outline-offset:3px}.route{padding:10px 18px;border-block:1px solid var(--border,#d6ddd8);font-size:12px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.route span{opacity:.7}.address{padding:10px 18px;font:11px ui-monospace,monospace;overflow-wrap:anywhere;border-bottom:1px solid var(--border,#d6ddd8)}iframe{display:block;border:0;width:100%;height:700px;color-scheme:inherit}.status{padding:10px 18px;margin:0;font-size:12px;border-top:1px solid var(--border,#d6ddd8)}details{border-top:1px solid var(--border,#d6ddd8);padding:14px 18px}summary{cursor:pointer;font-weight:600}.trace{max-height:260px;overflow:auto;padding:0;list-style:none;font:11px/1.7 ui-monospace,monospace}.trace li{padding:6px 0;border-bottom:1px solid var(--border,#d6ddd8);overflow-wrap:anywhere}.trace b{display:inline-block;min-width:92px}.hint{font-size:12px;opacity:.7;margin:8px 0 0}
  .provider-layer{position:fixed;inset:0;z-index:1;display:grid;place-items:center;padding:16px;background:#0b141969;backdrop-filter:blur(3px)}.provider-layer[hidden]{display:none}dialog{position:static;display:flex;flex-direction:column;margin:0;padding:0;border:1px solid var(--border,#d6ddd8);border-radius:16px;width:min(540px,100%);height:min(820px,100%);background:var(--bg,#fff);color:inherit;box-shadow:0 24px 100px #0005;overflow:hidden}dialog:not([open]){display:none}.popup-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--border,#d6ddd8)}.popup-bar strong{display:block;font-size:13px}.popup-bar small{font:11px ui-monospace,monospace;opacity:.7}.popup-bar button{${closeButtonStyle}}.popup-bar button:hover{background:light-dark(#f4f4f5,#242428);border-color:transparent}.popup-bar button svg{display:block}dialog iframe{flex:1;min-height:0;height:auto}.provider-status{padding:14px;margin:0;font-size:13px}@media(max-width:500px){iframe{height:750px}.toolbar label{width:100%}select{width:100%}}
  </style><div class="shell"><div class="toolbar"><label>Provider profile<select class="profile" aria-label="Provider profile"><option value="google">Google-style OIDC</option><option value="apple">Apple-style OIDC</option><option value="microsoft">Microsoft-style OIDC</option><option value="github">GitHub-style OAuth</option></select></label><label>Provider behavior<select aria-label="Provider behavior"></select></label><label>Sign-in flow<select class="flow" aria-label="Sign-in flow"><option value="popup">Popup</option><option value="redirect">Redirect</option></select></label><label>Appearance<select class="theme-choice" aria-label="Appearance"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label><label>Account selection<select class="account-choice" aria-label="Account selection"><option value="choose">Always choose</option><option value="reuse">Reuse last account</option></select></label><button type="button" class="reset">Reset example</button></div><div class="route"><strong>App → OAuth Mock</strong><span>In process · no network</span></div><div class="address" aria-label="Virtual browser address"></div><iframe class="app-frame" title="Side A listening journal" sandbox="allow-same-origin allow-forms"></iframe><p class="status" role="status" aria-live="polite">Starting the app…</p><details><summary>Request trace <span class="count">(0)</span></summary><p class="hint">Real Request / Response objects. Credentials and query strings are omitted.</p><ol class="trace"></ol></details></div><div class="provider-layer" hidden><dialog aria-label="OAuth Mock sign-in" aria-modal="true"><div class="popup-bar"><div><strong>OAuth Mock</strong><small class="provider-address">accounts.example.test</small></div><button type="button" class="close-provider" aria-label="Close sign-in popup">${closeIcon}</button></div><p class="provider-status" role="status">Connecting to the identity provider…</p><iframe class="provider-frame" title="OAuth Mock account selection and consent" sandbox="allow-same-origin allow-forms"></iframe></dialog></div>`
  function element<T extends Element>(selector: string): T {
    const value = root.querySelector<T>(selector)
    if (!value) throw new Error(`Missing example element: ${selector}`)
    return value
  }
  const frame = element<HTMLIFrameElement>(".app-frame")
  const shell = element<HTMLElement>(".shell")
  const layer = element<HTMLElement>(".provider-layer")
  const dialog = element<HTMLDialogElement>("dialog")
  const dialogFrame = element<HTMLIFrameElement>(".provider-frame")
  let popup: Window | null = null
  let popupTimer: ReturnType<typeof setInterval> | undefined
  let providerFrame = dialogFrame
  let providerAddress = element<HTMLElement>(".provider-address")
  let providerStatus = element<HTMLElement>(".provider-status")
  const frameUrls = new WeakMap<HTMLIFrameElement, string>()
  let navigation = 0
  const status = element<HTMLElement>(".status")
  const address = element<HTMLElement>(".address")
  const profile = element<HTMLSelectElement>(".profile")
  const select = element<HTMLSelectElement>('[aria-label="Provider behavior"]')
  const flow = element<HTMLSelectElement>(".flow")
  const appearance = element<HTMLSelectElement>(".theme-choice")
  const accountChoice = element<HTMLSelectElement>(".account-choice")
  flow.value = options.flow ?? "popup"
  appearance.value = options.theme ?? "system"
  accountChoice.value = options.reuseLastAccount ? "reuse" : "choose"
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
  let preferences = { reuseLastAccount: false }
  const traceList = element<HTMLOListElement>(".trace")
  const count = element<HTMLElement>(".count")
  let generation = 0
  let disposed = false
  let busy = false
  let browser: ReturnType<typeof createBrowser>
  let entries: Trace[] = []
  const behaviorChoices: Record<ExampleProvider, [string, string][]> = {
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
  function updateBehaviorChoices() {
    const previous = select.value
    select.replaceChildren(
      ...behaviorChoices[profile.value as ExampleProvider].map(([value, label]) => {
        const option = document.createElement("option")
        option.value = value
        option.textContent = label
        return option
      }),
    )
    if ([...select.options].some((option) => option.value === previous)) select.value = previous
  }
  function log(entry: Trace) {
    entries.push(entry)
    entries = entries.sort((a, b) => a.sequence - b.sequence).slice(-100)
    traceList.replaceChildren(
      ...entries.map((item) => {
        const li = document.createElement("li")
        const actor = document.createElement("b")
        actor.textContent = item.actor
        li.append(actor, ` ${item.method} ${item.url} → ${item.status}`)
        return li
      }),
    )
    count.textContent = `(${entries.length})`
  }
  function focusApp() {
    const doc = frame.contentDocument
    const target =
      doc?.querySelector<HTMLElement>('a[href="/auth/start"]') ??
      doc?.querySelector<HTMLElement>("h1")
    if (target) {
      if (target.tagName === "H1") target.tabIndex = -1
      target.focus({ preventScroll: true })
    }
  }
  function closeProvider() {
    if (popupTimer) clearInterval(popupTimer)
    popupTimer = undefined
    popup?.close()
    popup = null
    if (dialog.open) dialog.close()
    layer.hidden = true
    shell.inert = false
    providerFrame.srcdoc = ""
    providerFrame = dialogFrame
  }
  function cancelProvider() {
    // Discard a response already in flight, so closing the popup cannot reopen it.
    navigation++
    busy = false
    closeProvider()
    status.textContent = "Sign-in window closed. You can try again."
    focusApp()
  }
  function colorScheme() {
    return appearance.value === "system"
      ? systemTheme.matches
        ? "dark"
        : "light"
      : appearance.value
  }
  function applyDocumentTheme(doc: Document) {
    doc.documentElement.style.colorScheme = colorScheme()
    doc.documentElement.dataset.theme = appearance.value
    for (const input of doc.querySelectorAll<HTMLInputElement>('input[name="oauth-theme"]'))
      input.checked = input.value === appearance.value
  }
  function syncTheme() {
    for (const target of new Set([frame, dialogFrame, providerFrame])) {
      target.style.colorScheme = colorScheme()
      if (target.contentDocument?.documentElement) applyDocumentTheme(target.contentDocument)
    }
    if (popup && !popup.closed) popup.document.documentElement.style.colorScheme = colorScheme()
  }
  function openProvider() {
    // Called synchronously from the host app's click to retain popup user activation.
    if (popup && !popup.closed) {
      popup.focus()
      return
    }
    if (dialog.open) return
    try {
      popup = window.open("about:blank", "", "popup,width=540,height=820")
    } catch {
      popup = null
    }
    if (popup) {
      try {
        popup.document.open()
        popup.document.write(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src about:; form-action 'none'; base-uri 'none'"><title>OAuth Mock</title><style>*{box-sizing:border-box}html{height:100%;overflow:hidden}body{height:100%;display:flex;flex-direction:column;overflow:hidden;margin:0;font:14px/1.5 system-ui;background:light-dark(#fff,#111113);color:light-dark(#18181b,#f4f4f5)}header{flex-shrink:0;display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid light-dark(#dedee3,#36363c)}strong{display:block;font-size:13px}small{font:11px ui-monospace,monospace;opacity:.7}button{${closeButtonStyle}}button:hover{background:light-dark(#f4f4f5,#242428)}button svg{display:block}button:focus-visible{outline:3px solid #71717a;outline-offset:3px}p{padding:14px;margin:0}iframe{display:block;width:100%;flex:1;min-height:0;border:0;color-scheme:inherit}</style></head><body><header><div><strong>OAuth Mock</strong><small>accounts.example.test</small></div><button aria-label="Close sign-in popup">${closeIcon}</button></header><p role="status">Connecting to the identity provider…</p><iframe title="OAuth Mock account selection and consent" sandbox="allow-same-origin allow-forms"></iframe></body></html>`,
        )
        popup.document.close()
        const child = popup.document.querySelector("iframe")
        const label = popup.document.querySelector("small")
        const message = popup.document.querySelector("p")
        if (!child || !label || !message) throw new Error("Popup unavailable")
        providerFrame = child
        providerAddress = label
        providerStatus = message
        child.addEventListener("load", () => loaded(child))
        popup.document.querySelector("button")?.addEventListener("click", cancelProvider)
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
    providerAddress = element<HTMLElement>(".provider-address")
    providerStatus = element<HTMLElement>(".provider-status")
    providerStatus.hidden = false
    providerStatus.textContent = "Connecting to the identity provider…"
    // Modal to the example, not to the page: the layer covers only this example's
    // own box (its host's containing block when embedded), and the app behind it
    // is inert while it is open — the same rules as showModal(), scoped.
    layer.hidden = false
    shell.inert = true
    dialog.show()
  }
  function render(target: HTMLIFrameElement, url: string, html: string) {
    // Each surface gets its own document. The provider always renders its real response HTML.
    const doc = new DOMParser().parseFromString(html, "text/html")
    const csp = doc.createElement("meta")
    csp.httpEquiv = "Content-Security-Policy"
    csp.content =
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'"
    doc.head.prepend(csp)
    // This sandbox's host bridges theme changes; standalone HTTP pages use their own script.
    for (const script of doc.querySelectorAll("script")) script.remove()
    applyDocumentTheme(doc)
    target.style.colorScheme = colorScheme()
    frameUrls.set(target, url)
    target.srcdoc = `<!doctype html>${doc.documentElement.outerHTML}`
  }
  async function navigate(url: string, init: Parameters<typeof browser.navigate>[1] = {}) {
    if (busy || disposed) return
    const run = generation
    const step = ++navigation
    busy = true
    status.textContent =
      flow.value === "popup" ? "Waiting for sign-in in the provider window…" : "Redirecting…"
    try {
      const result = await browser.navigate(url, init)
      const html = await result.response.text()
      if (run !== generation || step !== navigation || disposed) return
      const location = new URL(result.url)
      if (location.origin === APP) {
        closeProvider()
        address.textContent = `${location.host}${location.pathname}`
        render(frame, result.url, html)
        status.textContent = result.response.ok
          ? flow.value === "popup"
            ? "App ready. Sign-in opens a separate provider window."
            : "App ready. Sign-in redirects to the provider and back."
          : "Sign-in did not complete. You’re back in the app and can try again."
      } else if (location.origin === IDENTITY) {
        if (flow.value === "redirect") {
          address.textContent = `${location.host}${location.pathname}`
          render(frame, result.url, html)
          status.textContent =
            "Redirected to OAuth Mock. Complete or cancel sign-in to return to the app."
          return
        }
        if (!popup && !dialog.open) throw new Error("The sign-in window was closed")
        providerAddress.textContent = `${location.host}${location.pathname}`
        providerStatus.hidden = true
        render(providerFrame, result.url, html)
        status.textContent =
          "Complete sign-in in the separate provider window. The app stays open here."
      }
    } catch (error) {
      if (run === generation && step === navigation && !disposed) {
        closeProvider()
        status.textContent = `Unable to continue: ${error instanceof Error ? error.message : "Unknown error"}. Try signing in again.`
        focusApp()
      }
    } finally {
      if (run === generation && step === navigation) busy = false
    }
  }
  function loaded(target: HTMLIFrameElement) {
    if (disposed) return
    const doc = target.contentDocument
    const currentUrl = frameUrls.get(target)
    if (!doc || !currentUrl || !doc.querySelector("main")) return
    applyDocumentTheme(doc)
    doc.addEventListener("change", (event) => {
      const input = event.target as HTMLInputElement
      if (input.name === "oauth-theme" && ["system", "light", "dark"].includes(input.value)) {
        appearance.value = input.value
        syncTheme()
      }
    })
    // A closed popup's delayed load event must never steal focus or submit another request.
    if (target !== frame && !popup && !dialog.open) return
    doc.addEventListener(
      "submit",
      (event) => {
        event.preventDefault()
        const form = event.target as HTMLFormElement
        const data = new FormData(form, (event as SubmitEvent).submitter)
        const params = new URLSearchParams()
        for (const [name, value] of data) if (typeof value === "string") params.append(name, value)
        const url = new URL(form.getAttribute("action") ?? currentUrl, currentUrl)
        const method = form.method.toUpperCase()
        if (method === "GET") url.search = params.toString()
        void navigate(url.href, {
          method,
          ...(method === "GET" ? {} : { body: params }),
          origin: new URL(currentUrl).origin,
        })
      },
      true,
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
          if (flow.value === "popup") openProvider()
        }
        void navigate(url.href)
      },
      true,
    )
    doc.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && target !== frame) {
        event.preventDefault()
        cancelProvider()
      }
    })
    const heading = doc.querySelector<HTMLElement>("h1")
    if (heading) {
      heading.tabIndex = -1
      heading.focus({ preventScroll: true })
    }
    // Apple's response_mode=form_post page auto-submits in a real browser. Scripts are removed
    // from the sandboxed source document, so the host performs that same native form submission.
    doc.querySelector<HTMLFormElement>("form#callback")?.requestSubmit()
  }
  function reset() {
    const run = ++generation
    navigation++
    closeProvider()
    busy = false
    entries = []
    traceList.replaceChildren()
    count.textContent = "(0)"
    const behavior: BehaviorInput =
      select.value === "unavailable"
        ? { probabilities: { tokenUnavailable: 1 } }
        : select.value === "normal"
          ? {}
          : { preset: select.value as Exclude<BehaviorInput["preset"], undefined> }
    const example = createExample(
      behavior,
      (entry) => {
        if (run === generation && !disposed) log(entry)
      },
      profile.value as ExampleProvider,
    )
    preferences = example.preferences
    preferences.reuseLastAccount = accountChoice.value === "reuse"
    browser = createBrowser(example.dispatch)
    void navigate(APP)
  }
  const appLoaded = () => loaded(frame)
  const providerLoaded = () => loaded(dialogFrame)
  frame.addEventListener("load", appLoaded)
  dialogFrame.addEventListener("load", providerLoaded)
  layer.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return
    // Claimed, so an embedding modal treats this close request as handled.
    event.preventDefault()
    cancelProvider()
  })
  element<HTMLButtonElement>(".close-provider").addEventListener("click", cancelProvider)
  appearance.addEventListener("change", syncTheme)
  systemTheme.addEventListener("change", syncTheme)
  accountChoice.addEventListener("change", () => {
    preferences.reuseLastAccount = accountChoice.value === "reuse"
  })
  profile.addEventListener("change", () => {
    updateBehaviorChoices()
    reset()
  })
  flow.addEventListener("change", () => {
    cancelProvider()
    void navigate(APP)
  })
  select.addEventListener("change", reset)
  element<HTMLButtonElement>(".reset").addEventListener("click", reset)
  updateBehaviorChoices()
  reset()
  return () => {
    disposed = true
    generation++
    closeProvider()
    systemTheme.removeEventListener("change", syncTheme)
    frame.removeEventListener("load", appLoaded)
    dialogFrame.removeEventListener("load", providerLoaded)
    root.replaceChildren()
  }
}
