import type { Meta, StoryObj } from "@storybook/html-vite"
import type { AppOptions } from "../src/ui/app.js"
import { allSources, base, everything, MAILBOX, PHONE, sms } from "./fixtures.js"
import { mount } from "./mount.js"

/** The whole harness page: chrome, source health, the channel tabs and every device together. */
const meta: Meta<AppOptions> = {
  title: "Harness/Page",
  tags: ["vp-desktop"],
  render: (args) => mount(args),
}
export default meta
type Story = StoryObj<AppOptions>

const all = everything()

export const AllDevices: Story = { args: base(all) }
export const AllDevicesEverythingRead: Story = { args: base(all, { seen: all.map((n) => n.id) }) }
export const OpenOnEachDevice: Story = {
  args: base(all, {
    initial: {
      sms: { to: PHONE, thread: "Verify" },
      email: {
        to: MAILBOX,
        open: all.find((n) => n.email?.subject.includes("#1042 is confirmed"))?.id ?? null,
      },
      push: { expanded: all.find((n) => n.push?.platform === "ios")?.id ?? null },
    },
  }),
}
export const NewArrivalsAnimating: Story = {
  args: base(all, { arrived: all.slice(0, 3).map((n) => n.id) }),
  parameters: { catalog: { note: "animations run to completion before the screenshot" } },
}

export const NoEmulatorsFound: Story = { args: base([], { sources: [] }) }
export const EmulatorsHealthyNothingSent: Story = { args: base([], { sources: allSources() }) }
export const FleetDiscoveryFailed: Story = {
  args: base([], {
    sources: [],
    discoveryError: "fleet http://127.0.0.1:9000/__admin/fleet: HTTP 401",
  }),
}
export const OneEmulatorFailing: Story = {
  args: base(all, {
    sources: allSources({ twilio: 8, resend: 2, fcm: 2 }).map((s) =>
      s.name === "ses"
        ? { ...s, ok: false, error: "GET /state/ses_messages: HTTP 503 upstream unavailable" }
        : s,
    ),
  }),
}
export const StreamReconnecting: Story = { args: base(all, { connected: false }) }
export const SourceAliasesInFleet: Story = {
  args: base(all, {
    sources: allSources({ twilio: 8 }).map((s) =>
      s.name === "fcm" ? { ...s, name: "push" } : s.name === "resend" ? { ...s, name: "mail" } : s,
    ),
  }),
}

export const SearchNarrowsEveryDevice: Story = { args: base(all, { initial: { search: "1042" } }) }
export const SearchMatchesNothing: Story = {
  args: base(all, { initial: { search: "no-such-recipient" } }),
}
export const FollowNewOff: Story = { args: base(all, { initial: { follow: false } }) }
export const ManyNamespaces: Story = {
  args: base(
    [
      sms({
        body: "worker 3 sign-in code 551203",
        from: "Verify",
        fromName: "Verify",
        code: "551203",
        namespace: "worker-3",
      }),
    ],
    {
      namespace: "worker-3",
      namespaces: ["default", "worker-1", "worker-2", "worker-3", "tenant-b"],
    },
  ),
}

export const DeepLinkSmsDevice: Story = {
  args: base(all, { search: `?view=sms&to=${encodeURIComponent(PHONE)}` }),
  tags: ["vp-phone"],
}
export const DeepLinkPushDevice: Story = {
  args: base(all, { search: "?view=push&to=android-c41e09ab77f2" }),
  tags: ["vp-phone"],
}
export const DeepLinkEmailDevice: Story = {
  args: base(all, { search: `?view=email&to=${encodeURIComponent(MAILBOX)}` }),
  tags: ["vp-mail"],
}
export const DeepLinkOneNotification: Story = {
  args: base(all, {
    search: `?id=${encodeURIComponent(all.find((n) => n.email?.subject === "Reset your password")?.id ?? "")}`,
  }),
}

export const DeepLinkChatDevice: Story = {
  args: base(all, { search: `?view=chat&to=${encodeURIComponent("#alerts")}` }),
  tags: ["vp-mail"],
}

export const OneChannelTab: Story = { args: base(all, { initial: { only: "chat" } }) }
export const TabsLayoutForced: Story = { args: base(all, { layout: "tabs" }) }
export const GridLayoutForced: Story = { args: base(all, { layout: "grid" }), tags: ["vp-mobile"] }
export const WithoutTabs: Story = { args: base(all, { tabs: false }) }
export const TwoChannelsOnly: Story = { args: base(all, { channels: ["sms", "chat"] }) }

export const LaptopWidth: Story = { args: base(all), tags: ["vp-laptop"] }
/** Narrow: the devices become tabs, one at a time; unread counts sit on the other tabs. */
export const NarrowLaptopWidth: Story = { args: base(all), tags: ["vp-laptop-narrow"] }
export const PhoneWidth: Story = { args: base(all), tags: ["vp-mobile"] }
export const PhoneWidthChatTab: Story = {
  args: base(all, { initial: { only: "chat" } }),
  tags: ["vp-mobile"],
}
export const PhoneWidthEmailTab: Story = {
  args: base(all, { initial: { only: "email" } }),
  tags: ["vp-mobile"],
}
