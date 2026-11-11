import {
  type AdminConfig,
  type AdminFetch,
  mount as mountAdmin,
} from "@crvouga/mockingbird-admin-ui/browser"
import type { MockAdmin } from "../adapters/admin.js"

/** The admin UI's own address. Its emulator, view and namespace never reach the page's URL. */
const ADMIN_ORIGIN = "https://emulator.local"
const ADMIN_URL = `${ADMIN_ORIGIN}/__admin/ui`

/** An open Ant Design overlay: a dialog, drawer, select list or menu. */
const ADMIN_OVERLAY = [
  ".ant-modal-wrap:not([style*='display: none'])",
  ".ant-drawer-open",
  ".ant-select-open",
  ".ant-dropdown:not(.ant-dropdown-hidden)",
  ".ant-picker-dropdown:not(.ant-picker-dropdown-hidden)",
].join(",")

/** Relative admin calls stay in-process. Absolute catalog URLs use the network. */
const adminFetch = (fetchImpl: MockAdmin["fetch"]): AdminFetch => {
  return (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, `${ADMIN_ORIGIN}/`)
    if (url.origin !== ADMIN_ORIGIN) return fetch(input, init)
    return fetchImpl(input instanceof Request ? new Request(url, input) : new Request(url, init))
  }
}

/**
 * Draws the shared emulator admin UI into the dashboard's Emulators panel,
 * answering its API calls from the in-process admins instead of a server.
 * It is bundled code mounted straight into the panel, never a document
 * fetched and pasted, which would mean evaluating its script from a string.
 */
export const mountEmulatorsPanel = (
  panel: HTMLElement,
  admin: Pick<MockAdmin, "fetch"> & { config: AdminConfig },
): (() => void) => {
  const frame = document.createElement("div")
  frame.style.cssText = "width:100%;height:100%;min-height:0;overflow:auto"
  frame.setAttribute("role", "region")
  frame.setAttribute("aria-label", "Emulator administration")
  frame.dataset.mockingbirdAdmin = ""
  panel.replaceChildren(frame)

  // Escape with an admin overlay open closes that overlay, and only that: a surrounding
  // dialog (the docs site opens the example in one) is asked to stay. The UI stops the key
  // from bubbling, so the dialog's own close request is what gets declined.
  let overlayOpen = false
  const trackOverlay = (event: KeyboardEvent): void => {
    overlayOpen = event.key === "Escape" && frame.querySelector(ADMIN_OVERLAY) !== null
  }
  frame.addEventListener("keydown", trackOverlay, { capture: true })
  const dialog = frame.closest("dialog")
  const keepDialog = (event: Event): void => {
    if (overlayOpen) event.preventDefault()
    overlayOpen = false
  }
  dialog?.addEventListener("cancel", keepDialog)

  const unmount = mountAdmin(frame, admin.config, {
    fetch: adminFetch(admin.fetch),
    location: { href: ADMIN_URL },
    // The host page has its own Command/Ctrl + K; the admin's applies while focus is in it.
    shortcutTarget: frame,
    viewport: frame,
    styleContainer: frame,
    // An emulator's custom panel script is a string. Nothing here evaluates strings.
    panelScript: false,
  })
  return () => {
    dialog?.removeEventListener("cancel", keepDialog)
    frame.removeEventListener("keydown", trackOverlay, { capture: true })
    unmount()
    frame.remove()
  }
}
