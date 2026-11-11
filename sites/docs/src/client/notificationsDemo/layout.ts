/**
 * How the landing page lays out the notifications UI for the width it has. Full size, the four
 * devices need `GRID_WIDTH` in a row and stand 760px tall, which no section of the page has room
 * for, so they are drawn smaller (`scale`), and below `TABS_BELOW` one at a time.
 *
 * `NotificationsDemo.astro` reserves the stage's height in CSS from the same numbers, so nothing
 * moves when the UI mounts: keep the two in step.
 */

/** Two phones (362px), the mail window (480px) and the chat window (340px), their gaps and padding. */
export const GRID_WIDTH = 1672

/** Narrower than this, four devices in a row would be too small to read. */
export const TABS_BELOW = 1040

export type DemoLayout = { layout: "grid" | "tabs"; scale: number }

export const deviceLayout = (width: number): DemoLayout => {
  if (width >= TABS_BELOW)
    return {
      layout: "grid",
      scale: Math.min(0.8, Math.floor((width / GRID_WIDTH) * 1000) / 1000),
    }
  return { layout: "tabs", scale: width < 520 ? 0.72 : 0.8 }
}

export const sameLayout = (a: DemoLayout, b: DemoLayout) =>
  a.layout === b.layout && a.scale === b.scale
