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

Rendered items carry `data-notification-id` and `data-testid` (`sms-bubble`, `sms-thread`,
`push-notification`, `email-row`, `email-open`, `email-subject`, …) so browser tests can find what
a user sees.

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

// A screenshot of the inbox, opened on that email.
await page.goto(notifications.link({ id: invite?.id }))
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
bun run --cwd packages/notifications dev   # a fleet of every messaging emulator, sample traffic, harness on :8790
```
