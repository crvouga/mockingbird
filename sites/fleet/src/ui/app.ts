/**
 * The dashboard. It holds no logic of its own: every screen is a rendering of control-API
 * responses and every action is one API call, the same calls an agent makes with an API key.
 *
 * This is the page's entry point. `router.ts` draws the screen for the address, `screens/` holds
 * one module per screen, and `routes.ts` lists them.
 */
import { mount, render } from "./router.js"

window.addEventListener("popstate", () => void render())
void mount(document.getElementById("app") as HTMLElement)
