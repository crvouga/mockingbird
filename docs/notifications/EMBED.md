# Embed the UI

Mount the devices inside your own page, for example as a tab of your development shell. With an in-process harness, the emulators, the harness and the UI all run in one browser tab, with no server.

<!-- search: embed mount mountNotifications ui browser tab panel shadow root scoped styles in-process dev shell -->

## Mount it

`@crvouga/mockingbird-notifications/ui` mounts the same UI the harness page serves:

```ts
import { createNotificationHarness } from "@crvouga/mockingbird-notifications"
import { mountNotifications } from "@crvouga/mockingbird-notifications/ui"
import { createRuntime as resend } from "@crvouga/mockingbird-service-resend"
import { createRuntime as twilio } from "@crvouga/mockingbird-service-twilio"

const harness = createNotificationHarness({ services: { twilio: twilio(), resend: resend() } })
const panel = document.getElementById("notifications") as HTMLElement
const ui = mountNotifications(panel, { harness, title: "My app notifications" })
await ui.ready
// ui.show({ channel: "sms", to: "+12025550123" }); ui.setSound(true); ui.setNamespace("worker-3")
ui.destroy()
```

The UI fills the element and scrolls inside it. It leaves the page URL alone unless `syncUrl` is set.

## Options

| Option | Does |
| --- | --- |
| `harness` | An in-process harness. Omit it to read `baseUrl` over HTTP. |
| `fetch`, `baseUrl` | A transport to a harness on another origin. |
| `title` | The name in the header. |
| `channels` | Which devices to show: any of `sms`, `push`, `email`, `chat`. Default all. |
| `layout` | `auto` (default): side by side, and one device at a time behind the [channel tabs](DEVICES.md#channel-tabs) when the element is narrower than 800px. `tabs` always shows one device; `grid` never collapses. |
| `tabs` | Show the channel tabs. Default `true`. |
| `chrome` | Show the header, filters and emulator status. Default `true`. |
| `scale` | Draw the devices at this fraction of full size, from `0.5` to `1`, for an element with less room than four full-size devices need (a phone is 362 by 760px). The tab breakpoint shrinks with it. Default `1`. |
| `sound` | Start with arrival sounds on. |
| `motion` | `auto`, `full` or `reduce`. |
| `onArrive` | Called with each new notification. |
| `syncUrl` | Read and write `?view=`-style [links](DEVICES.md#links) on the page. |
| `injectStyles` | Add the stylesheets to the document or shadow root. Default `true`. |

The handle has `ready`, `show`, `setNamespace`, `setSound`, `setScale`, `render` and `destroy`.

## The dashboard

`mountDashboard` puts the Mockingbird shell (the top bar with the bird, your title and the light/dark switch) and a set of tabs over the notifications UI and an emulators panel you draw, so a development shell gets both in one element. Tabs are your own `tabs`, then **Emulators**, then **Notifications**; a tab is drawn the first time it is shown and stays mounted, and the Notifications tab counts what arrives while another tab is open.

```ts
import { mountDashboard } from "@crvouga/mockingbird-notifications/ui"

const dashboard = mountDashboard(document.getElementById("lab") as HTMLElement, {
  title: "Acme lab",
  emulators: { mount: (panel) => mountMyAdmin(panel) }, // may be async; may return a dispose function
  notifications: { harness },                           // what mountNotifications takes
  syncUrl: true,                                        // read and write ?tab=
})
dashboard.show("notifications")
dashboard.destroy()
```

| Option | Does |
| --- | --- |
| `emulators` | `{ mount(panel), label? }`: the Emulators tab. `mount` draws into `panel` and may return, or resolve to, a dispose function. |
| `notifications` | `mountNotifications` options plus `label`: the Notifications tab. |
| `tabs` | Your own tabs, shown first: `{ id, label, mount(panel) }`. |
| `title` | The product name in the top bar, beside the bird. |
| `initialTab` | The tab to open. Default: the first. |
| `syncUrl` | Read `?tab=` and keep it current. |
| `onTabChange` | Called with the tab id on each switch. |
| `theme` | `auto` (default) follows the viewer's light or dark setting; `light` or `dark` pins one. |
| `injectStyles` | Add the stylesheets. Default `true`. |

The handle has `show(id)`, `active()`, `tabs()`, `aside` (an empty element in the top bar's actions), `notifications` (the notifications handle) and `destroy()`. Give the element a height: the dashboard fills it and scrolls inside. It adds no inline script, so it runs under a strict Content-Security-Policy. The harness page uses the same function, with every emulator's admin UI as the emulators panel: see [Run against a fleet](RUN_AGAINST_A_FLEET.md#the-dashboard).

## Styles

The UI is built with React and [HeroUI](https://heroui.com), Mockingbird's design system, and ships prebuilt inside the package, so your app needs neither. It adds two stylesheets once to the document, or to the shadow root that holds the element: Mockingbird's (`MOCKINGBIRD_CSS` from `@crvouga/mockingbird-ui/styles`, the theme every Mockingbird UI shares) and the device skins (`STYLES`, every rule scoped to the UI's root, `.mb-notifications`). To ship them yourself, for example under a Content-Security-Policy that blocks `<style>` elements added at runtime, pass `injectStyles: false` and serve `@crvouga/mockingbird-ui/styles.css` and `STYLES` as files.

## A working example

The [lab ordering example](https://github.com/crvouga-organization/mockingbird/tree/main/packages/examples/medical-testing) mounts it as its **Notifications** tab, with Twilio, Resend and FCM emulators in the same tab. [Launch it](https://mockingbird.chrisvouga.dev/examples/medical-testing) and place an order.
