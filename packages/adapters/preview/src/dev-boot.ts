/**
 * The boot loader `devPreview` serves: `bootPreview`, plus the one thing a deployed preview never
 * needs, a build error shown in the page. While the dev server's last build is failing, a small
 * card in the corner holds the compiler's message; the app underneath keeps running its last good
 * version, and the card goes away with the next good build.
 *
 * Also the page the dev server answers with before any build has succeeded (`devWaitingPage`).
 *
 * Browser: `document`, `EventSource`.
 */
import { type BootPreviewOptions, bootPreview } from "./boot.js"
import type { PreviewStatusSnapshot } from "./preview-status.js"

export const DEV_ERROR_ID = "mockingbird-preview-dev-error"

/** Draws (or, with `undefined`, removes) the build error card. Styled in a shadow root. */
export function showDevBuildError(doc: Document, message: string | undefined): void {
  const existing = doc.getElementById(DEV_ERROR_ID)
  if (message === undefined) {
    existing?.remove()
    return
  }
  const host = existing ?? doc.createElement("div")
  if (!existing) {
    host.id = DEV_ERROR_ID
    host.setAttribute("role", "alert")
    host.style.cssText =
      "position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:min(720px,calc(100vw - 24px))"
    host.attachShadow({ mode: "open" })
    doc.body.append(host)
  }
  const root = host.shadowRoot as ShadowRoot
  root.replaceChildren()
  const style = doc.createElement("style")
  style.textContent =
    ":host{color-scheme:light dark}section{background:Canvas;color:CanvasText;border:1px solid #d1242f;border-radius:6px;box-shadow:0 4px 16px rgb(0 0 0/.2);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden}header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 8px 6px 12px;font-family:system-ui,sans-serif;font-weight:600;color:#d1242f}button{all:unset;cursor:pointer;padding:0 6px;border-radius:4px;color:CanvasText;opacity:.6}button:hover,button:focus-visible{opacity:1;outline:1px solid currentColor}pre{margin:0;padding:0 12px 10px;max-height:40vh;overflow:auto;white-space:pre-wrap;word-break:break-word}"
  const card = doc.createElement("section")
  const header = doc.createElement("header")
  header.textContent = "Build failed · still running the last good version"
  const close = doc.createElement("button")
  close.type = "button"
  close.setAttribute("aria-label", "Dismiss")
  close.textContent = "✕"
  close.addEventListener("click", () => host.remove())
  header.append(close)
  const text = doc.createElement("pre")
  text.textContent = message
  card.append(header, text)
  root.append(style, card)
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  )

/**
 * The page the dev server answers with while no build has succeeded yet: the compiler's message
 * (or, with `undefined`, that the first build is running), reloading itself into the app as soon
 * as a build succeeds, and again when the message changes.
 */
export const devWaitingPage = (message: string | undefined): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${message === undefined ? "Building…" : "Build failed"}</title>
<style>body{margin:0;padding:24px;font:14px/1.5 system-ui,sans-serif}h1{font-size:16px;margin:0 0 12px}pre{margin:0;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}</style>
</head><body><h1>${message === undefined ? "Building the preview…" : "The preview does not build yet"}</h1><pre>${escapeHtml(message ?? "")}</pre>
<script>(()=>{const s=new EventSource("/__preview/live?overlay");let first=true;s.addEventListener("snapshot",e=>{const d=JSON.parse(e.data);if(d.deployed||(!first&&d.build&&d.build.state==="failed"))location.reload();first=false})})()</script>
</body></html>
`

/** Boots the preview and keeps the build error card in step with the dev server's status. */
export function bootDevPreview(options: BootPreviewOptions = {}): void {
  // Before the app loads: it may replace the globals (the browser runtime routes fetch and
  // EventSource to in-page servers), and the dev server must stay reachable.
  const Source = (globalThis as { EventSource?: typeof EventSource }).EventSource
  const baseUrl = options.baseUrl ?? document.baseURI
  if (Source) {
    const source = new Source(new URL("/__preview/live?overlay", baseUrl).href)
    let shown: string | undefined
    source.addEventListener("snapshot", (event) => {
      try {
        const { build } = JSON.parse(String((event as MessageEvent).data)) as PreviewStatusSnapshot
        const failed =
          build?.state === "failed" ? `${build.at}\n${build.message ?? "Build failed"}` : undefined
        if (failed === shown) return
        shown = failed
        showDevBuildError(document, failed === undefined ? undefined : (build?.message ?? ""))
      } catch {
        // Not a snapshot.
      }
    })
  }
  bootPreview(options).catch(() => {})
}
