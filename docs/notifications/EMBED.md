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
| `title` | The name in the top bar. |
| `channels` | Which devices to show. |
| `chrome` | Show the top bar. |
| `sound` | Start with arrival sounds on. |
| `motion` | `auto`, `full` or `reduce`. |
| `onArrive` | Called with each new notification. |
| `syncUrl` | Read and write `?view=`-style [links](DEVICES.md#links) on the page. |
| `injectStyles` | Add the stylesheet to the document or shadow root. Default `true`. |

The handle has `ready`, `show`, `setNamespace`, `setSound`, `render` and `destroy`.

## Styles

Every rule is scoped to the UI's root (`.mb-notifications`) and added once to the document, or to the shadow root that holds the element, so it sits next to your app's own styles. To ship the stylesheet yourself, for example under a Content-Security-Policy that blocks `<style>` elements added at runtime, pass `injectStyles: false` and serve `STYLES` from `@crvouga/mockingbird-notifications/ui` as a file.

## A working example

The [lab ordering example](https://github.com/crvouga/mockingbird/tree/main/packages/examples/medical-testing) mounts it as its **Notifications** tab, with Twilio, Resend and FCM emulators in the same tab. [Launch it](https://mockingbird.chrisvouga.dev/examples/medical-testing) and place an order.
