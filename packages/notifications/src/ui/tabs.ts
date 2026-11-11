/**
 * The channel tab bar's rules, kept free of the DOM so they are unit-tested directly.
 *
 * Wide, the bar is `All | Text | Push | Email | Chat` and "All" lays every device side by side.
 * Narrow (or with `layout: "tabs"`), there is no "All": exactly one device shows at a time.
 */
import type { Channel } from "../model.js"

export type ChannelTab = Channel | "all"

export type DeviceLayout = "auto" | "tabs" | "grid"

/** Below this container width only one phone fits per row, so the devices become tabs. */
export const TABS_BELOW_WIDTH = 800

export const TAB_LABELS: Record<ChannelTab, string> = {
  all: "All",
  sms: "Text",
  push: "Push",
  email: "Email",
  chat: "Chat",
}

/** The smallest `scale` the devices are drawn at; below it the text on them is unreadable. */
export const MIN_SCALE = 0.5

/** The `scale` option as a usable factor: 1 unless it is a number, and kept within `MIN_SCALE`..1. */
export const deviceScale = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(MIN_SCALE, Math.min(1, value)) : 1

/**
 * Whether the devices collapse to one-at-a-time tabs at this container width. Devices drawn at a
 * smaller `scale` need less room, so the breakpoint shrinks with them.
 */
export const isCompact = (layout: DeviceLayout, width: number, scale = 1): boolean =>
  layout === "tabs" || (layout === "auto" && width > 0 && width / scale < TABS_BELOW_WIDTH)

/** How far a phone must shrink, on top of `scale`, to fit a container this wide (0.5 to 1). */
export const phoneFit = (width: number, scale = 1): number =>
  Math.max(0.5, Math.min(1, (width / scale - 16) / 362))

/** The tabs to draw, in order. A single enabled channel needs no tab bar. */
export const tabsFor = (enabled: readonly Channel[], compact: boolean): ChannelTab[] =>
  enabled.length < 2 ? [] : compact ? [...enabled] : ["all", ...enabled]

/**
 * The selected tab. `only` is the viewer's choice (`null` = all); compact has no "all", so it
 * falls back to the channel last looked at, or the first enabled one.
 */
export const activeTab = (
  enabled: readonly Channel[],
  compact: boolean,
  only: Channel | null,
  fallback: Channel | null,
): ChannelTab => {
  if (only && enabled.includes(only)) return only
  if (enabled.length === 1 && enabled[0]) return enabled[0]
  if (!compact) return "all"
  return (fallback && enabled.includes(fallback) ? fallback : enabled[0]) ?? "all"
}

/** Arrow-key navigation within a tab list: Left/Right wrap, Home/End jump. */
export const moveTab = (
  tabs: readonly ChannelTab[],
  current: ChannelTab,
  key: string,
): ChannelTab | null => {
  if (!tabs.length) return null
  const index = Math.max(0, tabs.indexOf(current))
  const next =
    key === "ArrowRight" || key === "ArrowDown"
      ? (index + 1) % tabs.length
      : key === "ArrowLeft" || key === "ArrowUp"
        ? (index - 1 + tabs.length) % tabs.length
        : key === "Home"
          ? 0
          : key === "End"
            ? tabs.length - 1
            : -1
  return next < 0 ? null : (tabs[next] ?? null)
}
