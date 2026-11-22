import { createApp } from "../src/ui/mount.js"
import type { AppOptions } from "../src/ui/types.js"

/** Render the harness UI from fixtures into a fresh element, as Storybook's HTML renderer expects. */
export const mount = (options: AppOptions): HTMLElement => {
  const root = document.createElement("div")
  root.dataset.title = "Notifications"
  createApp(root, options)
  return root
}
