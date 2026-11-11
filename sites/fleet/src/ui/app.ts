/**
 * The dashboard. It holds no logic of its own: every screen is a rendering of control-API
 * responses and every action is one API call, the same calls an agent makes with an API key.
 *
 * This is the page's entry point. `routes.ts` lists every address and says whether it is a query
 * (shows data and links) or a mutation (one form, one submit); `router.ts` draws the surface for
 * the address, `screens/` holds the screens and `form.ts` is the one layout every mutation uses.
 */
import { mount, revisit } from "./router.js"

window.addEventListener("popstate", () => void revisit())
void mount(document.getElementById("app") as HTMLElement)
