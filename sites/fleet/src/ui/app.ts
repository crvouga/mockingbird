/**
 * The dashboard. It holds no logic of its own: every screen is a rendering of control-API
 * responses and every action is one API call, the same calls an agent makes with an API key.
 *
 * This is the page's entry point. `routes.ts` lists every address and says whether it is a query
 * (shows data and links) or a mutation (one form, one submit); `router.tsx` draws the surface for
 * the address, `screens/` holds the screens, `kit.tsx` the markup they share and `form.tsx` the
 * one layout every mutation uses. They are React and HeroUI, styled by Mockingbird's stylesheet.
 */
import { THEME_STORAGE_KEY } from "@crvouga/mockingbird-ui/react"
import { mount, revisit } from "./router.js"

// The visitor's light or dark choice (the theme switch stores it), before anything is drawn.
try {
  const theme = localStorage.getItem(THEME_STORAGE_KEY)
  if (theme === "light" || theme === "dark") {
    document.documentElement.classList.add(theme)
    document.documentElement.dataset.theme = theme
  }
} catch {
  // Storage can be blocked; the page then follows the system's preference.
}

window.addEventListener("popstate", () => void revisit())
void mount(document.getElementById("app") as HTMLElement)
