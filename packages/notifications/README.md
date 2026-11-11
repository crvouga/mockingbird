# @crvouga/mockingbird-notifications

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

A notification test harness for a Mockingbird fleet. It reads the same emulators your application
sends through and shows every SMS, email and push the way the recipient would see it: a phone's
Messages app, a phone lock screen (iOS) or notification shade (Android), and a webmail inbox.
Automated tests get the same data from a JSON API and a small client.

| Channel | Emulators read | Shown as |
| --- | --- | --- |
| SMS | Twilio (Messages and Verify codes), Amazon SNS (direct `PhoneNumber` and `sms` topic subscribers), Customer.io, Mailosaur | Messages app: threads per sender, bubbles, one-time code suggestion |
| Email | Resend, Amazon SES (`SendEmail` and MIME `SendRawEmail`), Amazon SNS (`email` / `email-json` subscribers), Customer.io, Mailosaur, Twilio Verify email | Webmail: inbox per recipient (to, cc, bcc), rendered HTML, attachments, headers |
| Push | Firebase Cloud Messaging | iOS lock screen or Android shade, chosen from the device token's platform; title, body, image, data, badge, sound |

The [Notifications guide](https://mockingbird.chrisvouga.dev/docs/notifications) on the docs site
splits this README into pages, and the
[lab ordering example](https://mockingbird.chrisvouga.dev/examples/medical-testing) runs it live.

The harness only reads. It sends `GET` requests to each emulator's admin routes (`/__admin/outbox`
or `/__admin/state/...`) and never changes emulator state. The device art is generic: no vendor
logos.

## Install

```sh
npm install -D @crvouga/mockingbird-notifications
```

Node 22 or newer. Install it next to `@crvouga/mockingbird-fleet` and the emulator packages your
application uses.

## Run it against your fleet

Start the fleet as usual, then point the harness at the fleet controller or its ready file:

```sh
mockingbird-fleet serve --config mockingbird.json --ready-file .mockingbird/ready.json
mockingbird-notifications serve --manifest .mockingbird/ready.json      # http://127.0.0.1:8790
# or, with the controller URL from the ready file:
mockingbird-notifications serve --fleet http://127.0.0.1:9000/__admin/fleet
```

With `--fleet`, the harness asks the controller what each entry is, so aliases work (`push` with
`target: "fcm"`), and it follows every namespace the fleet has. With `--manifest`, the file is
re-read on every sync, so a restarted fleet on new ports is picked up. Entries that are not
messaging emulators (Stripe, Postgres, …) are skipped. Emulators outside a fleet can be named
directly:

```sh
mockingbird-notifications serve --service twilio=http://127.0.0.1:8798 --service resend=http://127.0.0.1:8794
```

| Flag | Meaning |
| --- | --- |
| `--fleet <url>` | Fleet controller `adminBase`. |
| `--manifest <file>` | The fleet's `--ready-file`. |
| `--service <name=url>` | One emulator (repeatable). The name is the service (`twilio`, `fcm`, …) or any alias; an alias is identified from the emulator's health route. |
| `--port`, `--host` | Listener. Default `127.0.0.1:8790`; `--port 0` picks a free port. |
| `--namespace <name>` | Watch this namespace in the background (repeatable). Default `default`, or every fleet namespace with `--fleet`. Any namespace the UI or an API call asks for is watched from then on. |
| `--poll <ms>` | Background poll interval, default 750. `0` reads only when asked. |
| `--admin-key-env <VAR>` | Environment variable with the admin key (default `MOCKINGBIRD_ADMIN_KEY`), sent as `x-mockingbird-admin-key`. |
| `--ready-json` | Print `{"url": …}` once listening. |

## The UI

`/` shows three devices side by side. Each has a recipient picker (phone number, push token,
mailbox) that follows the newest arrival unless **Follow new** is off. The **Timeline** tab lists
everything in one table; double-click any message, or click a timeline row, to inspect the
normalized record and the emulator's raw one. Read state is kept per browser.

Links open one device for a screenshot, for example in a Playwright test:

| Query | Effect |
| --- | --- |
| `?namespace=worker-3` | Show that namespace. |
| `?view=sms\|push\|email&to=<recipient>` | Show only that device, opened on that recipient (an SMS link opens the newest thread). |
| `?id=<notification id>` | Open that notification on its device. |
| `?view=timeline` | Open the timeline. |
| `?follow=0` | Do not jump to new arrivals. |

The devices behave like the real apps, in a generic style with no vendor marks:

- **Messages:** swipe a conversation left for Hide Alerts and Delete, or right for Pin and
  Unread. Swipe the open conversation left to see each message's time, and long-press a message
  for tapbacks and Copy. One-time codes show above the keyboard.
- **Lock screen (iOS):** notifications group by app. Tap a group to open it, swipe a card left for
  Options and Clear, and long-press it for a preview.
- **Notification shade (Android):** tap a card to expand it, swipe it either way to dismiss it,
  long-press it for its settings, and use Clear all.
- **Mail:** hover a row for Archive, Delete and Mark as read, then Undo from the toast. Star rows,
  and open a message to read its HTML.

Every gesture also works with a click or the keyboard. Dismissing, archiving or deleting only hides
the message in this browser; the harness keeps every record, and a reload brings it back.

**Sound** (off by default; the top bar's speaker toggles it, and `?sound=1` turns it on): new
arrivals play a synthesized chime in each platform's style, and phones vibrate where the browser
allows. **Motion:** arrivals, swipes, stacks and screen changes are animated. A viewer's
reduced-motion setting turns animation off, and so does the `motion: "reduce"` option.

## End-to-end tests

The UI is built to be driven by Playwright, Cypress or any WebDriver client. It gives tests three
things:

1. **A ready signal.** The root, `[data-testid="notifications-app"]`, gets `data-ready="true"`
   once its first read is drawn. It also reports `data-count`, `data-version`, `data-view`,
   `data-namespace`, `data-connected`, `data-sound` and `data-motion`.
2. **A `data-testid` on everything a user can see or press.** `TEST_IDS` names them all, and its
   typings say what each one marks.
3. **The notification's fields on each element that shows it.** Every bubble, thread, card, row,
   open email and timeline row carries `data-notification-id`, `data-channel`, `data-service`,
   `data-source`, `data-to`, `data-from`, `data-status`, `data-created-at` and `data-unread`. A
   bubble that holds a one-time code also has `data-code`. Use these to find an element by what the
   test knows instead of by its position.

Wait for the API first, then open a link to the message and assert on what the user would see:

```ts
import { NotificationClient, selectors, TEST_IDS } from "@crvouga/mockingbird-notifications"
import { expect, test } from "@playwright/test"

const notifications = new NotificationClient("http://127.0.0.1:8790")

test("the invitation email reaches Ada's inbox", async ({ page }) => {
  // …the app sends the invitation…
  const [invite] = await notifications.waitFor({ channel: "email", to: "ada@example.com", contains: "invited" })
  if (!invite) throw new Error("no invitation")

  await page.goto(notifications.link({ id: invite.id })) // opens the inbox on that email
  await page.locator(selectors.ready()).waitFor()

  await expect(page.getByTestId(TEST_IDS.emailSubject)).toHaveText("You're invited")
  // The HTML body is a same-origin iframe.
  const body = page.frameLocator(selectors.testId(TEST_IDS.emailBody))
  await expect(body.getByRole("link", { name: "Accept" })).toBeVisible()
})

test("the sign-in code is offered above the keyboard", async ({ page }) => {
  const code = await notifications.waitForCode("+12025550123")
  const [text] = await notifications.list({ channel: "sms", to: "+12025550123", contains: code })
  await page.goto(notifications.link({ id: text?.id }))
  await expect(page.locator(selectors.smsBubble({ id: text?.id }))).toHaveAttribute("data-code", code)
  await expect(page.getByTestId(TEST_IDS.smsCode)).toHaveAttribute("data-code", code)
})
```

`selectors` builds the common CSS selectors: `ready()`, `testId(id)`, `notification(id)`,
`smsBubble({from, id})`, `smsThread(from)`, `pushNotification(id)`, `emailRow(id)` and
`timelineRow(id)`.

| Device | Main test ids | State attributes |
| --- | --- | --- |
| Top bar | `namespace`, `search`, `view-devices`, `view-timeline`, `follow`, `sound-toggle`, `connection`, `source`, `notice`, `toast`, `toast-undo` | `source`: `data-name`, `data-service`, `data-ok`, `data-count`. `connection`: `data-state`. |
| Messages | `sms-device`, `sms-recipient`, `sms-thread` (`-name`, `-preview`, `-time`, `-unread`), `sms-conversation`, `sms-back`, `sms-bubble`, `sms-code`, `sms-menu`, `sms-menu-tapback`, `sms-tapback`, `sms-empty` | `sms-device`: `data-screen` (`threads` or `conversation`), `data-recipient`, `data-thread`. `sms-thread`: `data-pinned`, `data-muted`. |
| Push | `push-device`, `push-recipient`, `push-skin`, `push-group`, `push-group-more`, `push-notification` (`-title`, `-body`, `-app`, `-time`, `-image`, `-data`, `-meta`), `push-clear`, `push-options`, `push-preview`, `push-settings`, `push-clear-all`, `push-empty` | `push-device`: `data-skin` (`ios` or `android`), `data-platform`. `push-notification`: `data-expanded`, `data-app`, `data-stacked`. |
| Mail | `email-device`, `email-recipient`, `email-row` (`-from`, `-subject`, `-snippet`, `-date`, `-star`, `-archive`, `-delete`), `email-open`, `email-subject`, `email-from-name`, `email-from-address`, `email-to`, `email-details`, `email-detail`, `email-body`, `email-text`, `email-attachment`, `email-empty` | `email-device`: `data-screen` (`inbox` or `message`). `email-detail`: `data-field`. `email-attachment`: `data-filename`, `data-content-type`, `data-size`. |
| Timeline | `timeline`, `timeline-row`, `inspector`, `inspector-json`, `inspector-field`, `inspector-close`, `inspector-show-on-device` | `inspector-json` holds the whole record, `raw` included, as JSON. |

Controls are real buttons, selects and inputs with accessible names, so `getByRole` works as well.
New arrivals are drawn live, so a test can keep a page open while the app sends. When several tests
share a harness, give each one its own namespace (`?namespace=`) or open a deep link to one
recipient: a link with `to=` stays on that recipient instead of following new arrivals. Set
`?follow=0` on any other link that should stay put.

[`e2e/ui.e2e.ts`](https://github.com/crvouga/mockingbird/blob/main/packages/notifications/e2e/ui.e2e.ts)
in this repository is a complete, passing example with real Twilio, Resend and FCM emulators.

## Embed the UI

`@crvouga/mockingbird-notifications/ui` mounts the same UI on any element, for example as a tab in
your own development shell. It reads an in-process harness directly, so the emulators, the harness
and the UI can all run in one browser tab with no server:

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

Its styles are scoped to the UI's root (`.mb-notifications`) and added once to the document, or to
the shadow root that holds `panel`. Options: `harness`, or `fetch` and `baseUrl` for a harness on
another origin; `channels` (which devices to show); `chrome` (show the top bar); `sound`; `motion`
(`auto`, `full` or `reduce`); `onArrive`; and `syncUrl`, which reads and writes `?view=`-style
links on the page. The [lab ordering example](https://github.com/crvouga/mockingbird/tree/main/packages/examples/medical-testing)
mounts it as its Notifications tab.

## Usage

`NotificationClient` talks to a running harness:

```ts
import { NotificationClient } from "@crvouga/mockingbird-notifications"

const notifications = new NotificationClient("http://127.0.0.1:8790", { namespace: "worker-3" })

// The app texts a sign-in code; the test reads it the way the user would.
const code = await notifications.waitForCode("+12025550123")

// The app emails an invitation.
const [invite] = await notifications.waitFor({ channel: "email", to: "ada@example.com", contains: "invited" })
console.log(invite?.email?.subject, invite?.email?.html)

// A link to the inbox opened on that email, e.g. for Playwright's `page.goto(url)` and a screenshot.
const url = notifications.link({ id: invite?.id })
```

Or run the harness inside the test process, against servers or in-process runtimes:

```ts
import { createNotificationHarness } from "@crvouga/mockingbird-notifications"
import { createRuntime as twilio } from "@crvouga/mockingbird-service-twilio"

const harness = createNotificationHarness({ services: { twilio: twilio() }, pollIntervalMs: 0 })
// …the app sends through the same runtime…
const [sms] = await harness.waitFor({ channel: "sms", to: "+12025550123" })
harness.close()
```

`createServer` from `@crvouga/mockingbird-notifications/server` serves the same harness over
`node:http` and takes the CLI's options (`fleet`, `manifest` as a path or object, `services`,
`namespaces`, `pollIntervalMs`, `adminKey`, `port`, `host`).

A read always reflects sends that finished before it started: `list`, `waitFor` and every API read
sync the emulators first instead of waiting for the next poll.

## HTTP API

All routes are `GET`. Filters: `channel` (`sms`, `email`, `push`), `service`, `source` (the fleet
entry name), `namespace` (default `default`), `to`, `contains` (case-insensitive text), `since`
(ISO-8601 or epoch ms).

| Route | Answer |
| --- | --- |
| `/api/notifications` | `{namespace, version, notifications}`, oldest first (`order=newest` reverses). |
| `/api/notifications/latest` | The newest match, or 404. |
| `/api/notifications/{id}` | One notification. |
| `/api/wait?timeoutMs=&count=` | `{notifications}` once `count` (default 1) match; 408 with what was found after `timeoutMs` (default 10000, at most 120000). |
| `/api/events?namespace=` | Server-sent events: `hello`, `change` (`{added, version}`) and `sources` every 2 s. |
| `/api/sources` | Each emulator: name, service, admin URL, `ok`, last error and count. |
| `/api/namespaces` | Namespaces watched. |

A notification:

```jsonc
{
  "id": "twilio:default:SMb6c1…",         // <fleet entry>:<namespace>:<provider id>[#mailbox]
  "providerId": "SMb6c1…",
  "channel": "sms",                       // sms | email | push
  "source": "twilio", "service": "twilio", "namespace": "default",
  "to": "+12025550123",                   // phone, mailbox (lower case), or push token
  "from": { "name": null, "address": "+15005550006" },
  "createdAt": "2026-11-10T06:39:06.886Z", // on the emulator's clock
  "preview": "Your code is 123456",
  "status": "queued",
  "sms": { "body": "Your code is 123456", "code": null, "media": [] },
  "email": null,                          // {subject, html, text, cc, bcc, replyTo, attachments, headers}
  "push": null,                           // {title, body, imageUrl, app, platform, data, badge, sound}
  "raw": { /* the emulator's own record */ }
}
```

An email to several recipients appears once in each mailbox (`to`, `cc` and `bcc`). When Resend
forwards to Mailosaur (`--forward-to-inbox`), the Mailosaur copy is hidden so the message shows once.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `createNotificationHarness` | function | The harness as a Fetch handler: `fetch`, `sync(namespace?)`, `list(filter)`, `waitFor(filter, {timeoutMs, count})`, `sources()`, `close()`. Options: `fleet`, `manifest`, `services`, `namespaces`, `pollIntervalMs`, `adminKey`, `fetch`, `title`. |
| `NotificationClient` | class | HTTP client for a running harness: `list`, `latest`, `waitFor`, `waitForCode`, `sources`, `link`. Options: `namespace`, `fetch`. |
| `matches` | function | `(notification, filter)` → whether it matches, as the API filters. |
| `parseMime` | function | The MIME reader used for SES raw email: headers, subject, addresses, text, HTML, attachments. |
| `SERVICE_KINDS`, `SERVICE_LABELS` | values | The emulators the harness reads, and their display names. |
| `TEST_IDS`, `selectors` | values | Every `data-testid` the UI renders, and CSS selector builders for browser tests. Also exported from `./ui`. |
| `mountNotifications` (`./ui`) | function | `(element, {harness, …})` → `{ready, show, setNamespace, setSound, render, destroy}`. Mounts the UI on an element. |
| `createApp`, `STYLES`, `ROOT_CLASS` (`./ui`) | browser | The UI without the style injection and embedded defaults, its scoped stylesheet, and its root class. |
| `createServer`, `manifestFile`, `DEFAULT_PORT` (`./server`) | Node | Serve the harness over `node:http`; `manifestFile(path)` re-reads a fleet ready file. Port 8790. |

## Not covered

- Customer.io renders templates on its side and the emulator keeps no body, so its email shows the
  template id and `message_data`. In-app (`inbox_message`) sends are not shown.
- SNS mobile push (platform endpoints) is not emulated, and SNS topic subscribers are matched by
  topic only.
- Twilio MMS media is not in the emulator's outbox, so bubbles show text only.
- Replying from a device. The harness shows what was sent; inbound traffic goes through each
  emulator's own admin routes.

## Develop

```sh
bun run --cwd packages/notifications dev        # a fleet of every messaging emulator, sample traffic, harness on :8790
bun run --cwd packages/notifications e2e        # the browser tests (bunx playwright install chromium first)
bun run --cwd packages/notifications storybook  # every UI state, from fixtures
```
