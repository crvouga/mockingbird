import type { Meta, StoryObj } from "@storybook/html-vite"
import { mountNotifications } from "../src/ui/embed.js"
import type { MountOptions } from "../src/ui/types.js"
import { base, everything } from "./fixtures.js"

/**
 * `mountNotifications` (`@crvouga/mockingbird-notifications/ui`): the UI in an embedder's panel,
 * as the lab ordering example's Notifications tab and the docs site's demo show it. It fills the
 * panel and scrolls inside it, and adds the stylesheets to the page once.
 */
const meta: Meta<MountOptions & { height: number }> = {
  title: "Harness/Embedded",
  tags: ["vp-laptop"],
  render: ({ height, ...options }) => {
    const panel = document.createElement("div")
    panel.style.cssText = `height:${height}px;margin:16px;border:1px solid var(--border);border-radius:12px;overflow:hidden`
    mountNotifications(panel, options)
    return panel
  },
}
export default meta
type Story = StoryObj<MountOptions & { height: number }>

const all = everything()

/** The whole UI in a panel: toolbar, channel tabs, devices. */
export const InAPanel: Story = { args: { ...base(all), height: 860 } }

/** `chrome: false`, `scale: 0.75`: only the devices, smaller, as the docs site's demo shows them. */
export const DevicesOnly: Story = {
  args: { ...base(all), chrome: false, scale: 0.75, layout: "grid", height: 720 },
}

/** `layout: "tabs"`: one device at a time, picked with the channel tabs. */
export const OneDeviceAtATime: Story = {
  args: { ...base(all), layout: "tabs", initial: { only: "push" }, height: 900 },
}
