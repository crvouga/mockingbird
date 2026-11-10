import type { Meta, StoryObj } from "@storybook/html-vite"
import type { AppOptions } from "../src/ui/app.js"
import { base, everything } from "./fixtures.js"
import { mount } from "./mount.js"

/** The timeline table and the JSON inspector drawer. */
const meta: Meta<AppOptions> = {
  title: "Harness/Timeline & Inspector",
  tags: ["vp-desktop"],
  render: (args) => mount(args),
}
export default meta
type Story = StoryObj<AppOptions>

const all = everything()
const first = (channel: "sms" | "email" | "push") =>
  all.find((n) => n.channel === channel)?.id ?? null

export const TimelineEverything: Story = { args: base(all, { initial: { view: "timeline" } }) }
export const TimelineEmpty: Story = { args: base([], { initial: { view: "timeline" } }) }
export const TimelineFiltered: Story = {
  args: base(all, { initial: { view: "timeline", search: "sns" } }),
}
export const InspectSms: Story = {
  args: base(all, { initial: { view: "timeline", inspect: first("sms") } }),
}
export const InspectEmail: Story = {
  args: base(all, { initial: { view: "timeline", inspect: first("email") } }),
}
export const InspectPush: Story = {
  args: base(all, { initial: { view: "timeline", inspect: first("push") } }),
}
export const InspectOverDevices: Story = {
  args: base(all, { initial: { inspect: first("push") } }),
}
export const InspectorOnPhone: Story = {
  args: base(all, { initial: { view: "timeline", inspect: first("email") } }),
  tags: ["vp-mobile"],
}
export const TimelineOnPhone: Story = {
  args: base(all, { initial: { view: "timeline" } }),
  tags: ["vp-mobile"],
}
