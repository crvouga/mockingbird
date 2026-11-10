import type { Meta, StoryObj } from "@storybook/html-vite"
import type { Notification } from "../src/model.js"
import type { AppOptions, PushSkin } from "../src/ui/app.js"
import { ANDROID_TOKEN, art, base, IOS_TOKEN, push } from "./fixtures.js"
import { mount } from "./mount.js"

/** Push on an iOS lock screen and an Android notification shade, with every content shape. */
const meta: Meta<AppOptions> = {
  title: "Devices/Push",
  tags: ["vp-phone"],
  render: (args) => mount(args),
}
export default meta
type Story = StoryObj<AppOptions>

const device = (
  skin: PushSkin,
  items: Notification[],
  expanded: string | null = null,
): AppOptions => base(items, { initial: { only: "push", push: { skin, expanded } } })

const ios = (o: Parameters<typeof push>[0] = {}) =>
  push({ token: IOS_TOKEN, platform: "ios", ...o })
const android = (o: Parameters<typeof push>[0] = {}) =>
  push({ token: ANDROID_TOKEN, platform: "android", ...o })

const hero = art("Rain jackets", "#0ea5e9", "#1e3a8a")
const many = (make: typeof ios) =>
  [
    ["Order confirmed", "Your trail running shoes are being packed."],
    ["Payment received", "We charged $142.00 to Visa •••• 4242."],
    ["Driver nearby", "Sam is 3 minutes away with your delivery."],
    ["New message", "Lin: Are we still on for the trail run Saturday?"],
    ["Price drop", "The Merino hoodie you saved is now $59."],
    ["Weekly summary", "You ran 24.6 miles this week. Nice work!"],
    ["Security alert", "New sign-in from Chrome on macOS."],
    ["Reminder", "Your return window closes in 2 days."],
  ].map(([title = "", body = ""], i) =>
    make({
      title,
      body,
      minutesAgo: i * 14 + 1,
      app: i % 3 === 0 ? "acme-shop" : i % 3 === 1 ? "acme-pay" : "trail-club",
    }),
  )

// iOS lock screen
export const IosEmpty: Story = { args: device("ios", []) }
export const IosSingle: Story = { args: device("ios", [ios()]) }
export const IosWithImageThumbnail: Story = {
  args: device("ios", [
    ios({
      title: "Flash sale ends tonight",
      body: "Take 20% off rain jackets until midnight.",
      imageUrl: hero,
    }),
  ]),
}
const iosRich = ios({
  title: "Flash sale ends tonight",
  body: "Take 20% off rain jackets until midnight. Members get free shipping on every order this weekend.",
  imageUrl: hero,
  data: { campaign: "fall-rain", deepLink: "acme://sale/rain" },
  badge: 3,
  sound: "default",
})
export const IosExpandedImageDataBadgeSound: Story = { args: device("ios", [iosRich], iosRich.id) }
export const IosNoTitle: Story = {
  args: device("ios", [ios({ title: null, body: "Your order shipped." })]),
}
export const IosLongBodyClamped: Story = {
  args: device("ios", [
    ios({ title: "Policy update", body: "We updated our privacy policy. ".repeat(12) }),
  ]),
}
export const IosStackOfManyWithMore: Story = { args: device("ios", many(ios)) }
const iosExpired = ios({
  title: "Your cart is waiting",
  body: "Complete your order before items sell out.",
  status: "expired",
  minutesAgo: 60 * 5,
})
export const IosExpiredStatusExpanded: Story = { args: device("ios", [iosExpired], iosExpired.id) }
export const IosRelativeTimes: Story = {
  args: device("ios", [
    ios({ title: "Now", minutesAgo: 0 }),
    ios({ title: "Minutes ago", minutesAgo: 9 }),
    ios({ title: "Hours ago", minutesAgo: 180 }),
    ios({ title: "Days ago", minutesAgo: 60 * 50 }),
  ]),
}

// Android shade
export const AndroidEmpty: Story = { args: device("android", []) }
export const AndroidSingle: Story = { args: device("android", [android()]) }
export const AndroidLargeIcon: Story = {
  args: device("android", [
    android({
      title: "Flash sale ends tonight",
      body: "Take 20% off rain jackets until midnight.",
      imageUrl: hero,
    }),
  ]),
}
const androidRich = android({
  title: "Flash sale ends tonight",
  body: "Take 20% off rain jackets until midnight. Members get free shipping on every order this weekend.",
  imageUrl: hero,
  data: { campaign: "fall-rain" },
  sound: "chime",
})
export const AndroidExpandedBigPicture: Story = {
  args: device("android", [androidRich], androidRich.id),
}
export const AndroidNoTitle: Story = {
  args: device("android", [android({ title: null, body: "Your order shipped." })]),
}
export const AndroidStackOfMany: Story = { args: device("android", many(android)) }
const dropped = android({
  title: "Daily deal",
  body: "Today only: 2-for-1 socks.",
  status: "dropped",
})
export const AndroidDroppedStatusExpanded: Story = {
  args: device("android", [dropped], dropped.id),
}

// Skin selection
export const AutoPicksAndroidFromToken: Story = {
  args: device("auto", [
    android({ title: "Auto skin", body: "This token registered as Android." }),
  ]),
}
export const AutoPicksIosFromToken: Story = {
  args: device("auto", [ios({ title: "Auto skin", body: "This token registered as iOS." })]),
}
export const WebTokenDefaultsToIos: Story = {
  args: device("auto", [
    push({
      token: "web-push-endpoint-1",
      platform: "web",
      title: "Web push",
      body: "A browser subscription.",
    }),
  ]),
}
export const AndroidTokenForcedToIos: Story = {
  args: device("ios", [
    android({ title: "Forced skin", body: "Shown on the iOS lock screen by choice." }),
  ]),
}
