import { pretty } from "./model.js"

type Link = {
  href: string
  download: string
  style: { display: string }
  click(): void
  remove(): void
}

/** The browser APIs a download needs. Passed in so tests can record the order of calls. */
export type DownloadEnvironment = {
  document: { body: { append(node: Link): void }; createElement(tag: "a"): Link }
  URL: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void }
  setTimeout(run: () => void, ms: number): unknown
}

/**
 * Firefox and Safari can drop a click on a link that is not in the document, and cancel
 * a download whose object URL is revoked before it starts. So the link is attached for
 * the click, and the URL is revoked on a later task, well after the download began.
 */
export const REVOKE_AFTER_MS = 40_000

/** Save `value` as a pretty-printed JSON file named `name`. */
export const downloadJson = (
  name: string,
  value: unknown,
  environment: DownloadEnvironment = globalThis as unknown as DownloadEnvironment,
): void => {
  const url = environment.URL.createObjectURL(
    new Blob([pretty(value)], { type: "application/json" }),
  )
  const link = environment.document.createElement("a")
  link.href = url
  link.download = name
  link.style.display = "none"
  environment.document.body.append(link)
  link.click()
  link.remove()
  environment.setTimeout(() => environment.URL.revokeObjectURL(url), REVOKE_AFTER_MS)
}
