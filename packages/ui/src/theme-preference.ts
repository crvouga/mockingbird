/**
 * The visitor's theme choice, outside React: the docs site and every Mockingbird surface keep it
 * under one localStorage key, so it holds across the pages of an origin.
 */
export const THEME_STORAGE_KEY = "mb:theme"

/** Pin `root` to light or dark (as HeroUI expects: a class and `data-theme`), or follow the system. */
export function applyStoredTheme(root: HTMLElement, theme: "system" | "light" | "dark"): void {
  root.classList.remove("light", "dark")
  if (theme === "system") {
    root.removeAttribute("data-theme")
    return
  }
  root.classList.add(theme)
  root.dataset.theme = theme
}

/**
 * An inline script for `<head>` that applies a stored choice before first paint, so a page does
 * not flash the system theme first. `renderDocument({ rememberTheme: true })` adds it.
 */
export const THEME_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="light"||t==="dark"){var r=document.documentElement;r.classList.add(t);r.dataset.theme=t}}catch(e){}`
