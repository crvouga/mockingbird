import type { Meta, StoryObj } from "@storybook/html-vite"
import type { AppOptions } from "../src/ui/app.js"
import { base, CHAT_CHANNEL, chat, chatChannels, ORDER_BLOCKS } from "./fixtures.js"
import { mount } from "./mount.js"

/** The team chat window: channels, bot messages, Block Kit and attachments. */
const meta: Meta<AppOptions> = {
  title: "Devices/Chat",
  tags: ["vp-mail"],
  render: (args) => mount(args),
}
export default meta
type Story = StoryObj<AppOptions>

const only = (
  items: ReturnType<typeof chatChannels>,
  extra: AppOptions["initial"] = {},
  rest: AppOptions = {},
) => base(items, { initial: { only: "chat", ...extra }, ...rest })

const channels = chatChannels()

export const NoMessagesYet: Story = { args: only([]) }
export const ChannelWithHistory: Story = { args: only(channels, { chat: { to: CHAT_CHANNEL } }) }
export const AllRead: Story = {
  args: only(channels, { chat: { to: CHAT_CHANNEL } }, { seen: channels.map((n) => n.id) }),
}
export const IncomingWebhook: Story = {
  args: only(channels, { chat: { to: "/services/T000/B000/XXXX" } }),
}
export const Reactions: Story = { args: only(channels, { chat: { to: "#general" } }) }
export const BlockKit: Story = {
  args: only([chat({ text: "Order #1042 shipped", blocks: ORDER_BLOCKS })]),
}
export const RichTextAndImages: Story = {
  args: only([
    chat({
      text: "Release notes",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "Release ", style: { bold: true } },
                { type: "text", text: "2026.11", style: { code: true } },
                { type: "text", text: " is out " },
                { type: "emoji", name: "tada" },
              ],
            },
            {
              type: "rich_text_list",
              style: "bullet",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "Faster checkout" }],
                },
                { type: "rich_text_section", elements: [{ type: "text", text: "New order page" }] },
              ],
            },
          ],
        },
        { type: "hologram" },
      ],
    }),
  ]),
}
export const EphemeralAndThreadReply: Story = {
  args: only([
    chat({ text: "Only you can see this reminder.", ephemeral: true, minutesAgo: 1 }),
    chat({ text: "Following up in the thread.", threadTs: "1794246060.000100", minutesAgo: 2 }),
    chat({ text: "The parent message.", minutesAgo: 3 }),
  ]),
}
export const UnsafeMarkupIsEscaped: Story = {
  args: only([
    chat({
      text: '<script>alert(1)</script> <javascript:alert(1)|click me> <img src=x onerror="alert(1)">',
    }),
  ]),
}
export const NarrowWindow: Story = { args: only(channels), tags: ["vp-mobile"] }
