/// <reference lib="dom" />
import type { AppOptions } from "./types.js"

/**
 * Offers each plain click on a link under `root` to the embedder's `openLink`, and keeps the
 * browser from opening the ones it follows itself. `root` is the UI's own element, or the document
 * of an email's frame, whose clicks never reach the page around it.
 */
export function attachOpenLink(
  root: HTMLElement | Document,
  openLink: AppOptions["openLink"],
): () => void {
  if (!openLink) return () => {}
  const click = (event: Event) => {
    const mouse = event as MouseEvent
    if (mouse.defaultPrevented || mouse.button !== 0) return
    const target = event.target as { closest?: (selector: string) => Element | null } | null
    const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null | undefined
    if (!anchor || !/^https?:$/.test(anchor.protocol)) return
    if (openLink(anchor.href)) event.preventDefault()
  }
  root.addEventListener("click", click)
  return () => root.removeEventListener("click", click)
}
