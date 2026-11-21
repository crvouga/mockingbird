/// <reference lib="dom" />

/**
 * An app's icon on the System screen and in the switcher's tooltips.
 *
 * - `svg`: inline SVG markup from your own code (it is inserted as markup, so never pass text a
 *   person or a server supplied). Draw with `currentColor` to follow the theme.
 * - `src`: an image URL.
 * - `favicon`: any URL on the app's site; its `/favicon.ico`, then `/apple-touch-icon.png`, is used.
 *
 * Whatever fails to load falls back to the app's first letter. No third-party icon service is
 * asked, so an app's domain never leaves the page.
 */
export type SystemIcon = { svg: string } | { src: string } | { favicon: string }

const stroke = (paths: string): { svg: string } => ({
  svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`,
})

/** Icons for the surfaces Mockingbird itself provides. */
export const SYSTEM_ICONS = {
  /** The System screen: the controls for everything else. */
  system: stroke(
    '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  ),
  /** The emulator admin UI: a rack of stand-in servers. */
  emulators: stroke(
    '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6"/>',
  ),
  /** The notification harness: every email, text, push and chat message sent. */
  notifications: stroke(
    '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  ),
} as const satisfies Record<string, SystemIcon>

/** The image URLs to try, in order, for an icon that is a picture. */
export function iconSources(icon: SystemIcon | undefined): string[] {
  if (!icon || "svg" in icon) return []
  if ("src" in icon) return [icon.src]
  try {
    return ["/favicon.ico", "/apple-touch-icon.png"].map((path) => new URL(path, icon.favicon).href)
  } catch {
    return []
  }
}

/**
 * Draws `icon` into `mark` (a sized box), trying each image source in turn and ending at the
 * label's first letter.
 */
export function paintIcon(mark: HTMLElement, icon: SystemIcon | undefined, label: string): void {
  const letter = () => {
    mark.dataset.icon = "letter"
    mark.textContent = (label.trim()[0] ?? "?").toUpperCase()
  }
  if (icon && "svg" in icon) {
    mark.dataset.icon = "svg"
    mark.innerHTML = icon.svg
    return
  }
  const sources = iconSources(icon)
  if (sources.length === 0) {
    letter()
    return
  }
  const img = mark.ownerDocument.createElement("img")
  img.alt = ""
  img.decoding = "async"
  img.referrerPolicy = "no-referrer"
  let next = 0
  const attempt = () => {
    const source = sources[next++]
    if (source === undefined) letter()
    else img.src = source
  }
  img.onerror = attempt
  mark.dataset.icon = "image"
  mark.replaceChildren(img)
  attempt()
}
