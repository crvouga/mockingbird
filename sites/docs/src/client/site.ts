/**
 * The little every page does without React: copy buttons and the platform's shortcut labels.
 * The top bar (search, theme) is React islands (src/ui), hydrated by Astro.
 */

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
if (!isMac) {
  for (const kbd of document.querySelectorAll("[data-mod-enter]")) kbd.textContent = "Ctrl ↵"
}

// Copy buttons (src/ui/code.tsx, and the code frames of rendered markdown): `data-copy="text"`,
// or the code of the nearest `[data-copy-scope]`.
document.addEventListener("click", async (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("[data-copy]")
  if (!button) return
  const text =
    button.dataset.copy ||
    button.closest("[data-copy-scope]")?.querySelector("pre, code")?.textContent ||
    ""
  const label = button.getAttribute("aria-label") ?? "Copy"
  try {
    await navigator.clipboard.writeText(text.replace(/\n$/, ""))
    button.setAttribute("data-copied", "")
    button.setAttribute("aria-label", "Copied")
    setTimeout(() => {
      button.removeAttribute("data-copied")
      button.setAttribute("aria-label", label)
    }, 1600)
  } catch {
    // Clipboard blocked (insecure context); the text stays selectable.
  }
})
