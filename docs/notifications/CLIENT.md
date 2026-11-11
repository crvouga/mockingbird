# Client and in-process harness

Read what your application sent from a test, with no browser: wait for a text, pull the one-time code out of it, or check an email's HTML. Use `NotificationClient` against a running harness, or run the harness inside the test process.

<!-- search: NotificationClient waitFor waitForCode list latest link createNotificationHarness in-process harness test bun test vitest jest one-time code otp sync -->

## Against a running harness

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

| Method | Does |
| --- | --- |
| `list(filter)` | Every match, oldest first. |
| `latest(filter)` | The newest match, or `null`. |
| `waitFor(filter, {timeoutMs, count})` | Resolves once `count` (default 1) match; throws with what was found after the timeout. |
| `waitForCode(to)` | Waits for an SMS to `to` and returns its one-time code (the Twilio Verify code, or the first run of 4 to 8 digits); throws when it has none. |
| `sources()` | Each emulator the harness reads, with its count and last error. |
| `link({ channel, to, id })` | A URL to the [devices](DEVICES.md) page, opened on one device, recipient or notification, in the client's namespace. |

A filter takes `channel` (`sms`, `email`, `push`), `service`, `source`, `namespace`, `to`, `contains` and `since`, as the [HTTP API](HTTP_API.md) does.

## In the test process

Run the harness against in-process runtimes, with no server and no port:

```ts
import { createNotificationHarness } from "@crvouga/mockingbird-notifications"
import { createRuntime as twilio } from "@crvouga/mockingbird-service-twilio"

const sms = twilio()
const harness = createNotificationHarness({ services: { twilio: sms }, pollIntervalMs: 0 })
// …the app sends through the same runtime…
const [text] = await harness.waitFor({ channel: "sms", to: "+12025550123" })
harness.close()
```

`createNotificationHarness` also accepts `fleet` or `manifest` instead of `services`, and returns a Fetch handler (`harness.fetch`) that answers the same [HTTP API](HTTP_API.md), plus `sync(namespace?)`, `list(filter)`, `waitFor(filter, options)`, `sources()` and `close()`.

## Freshness

A read always reflects sends that finished before it started: `list`, `waitFor` and every API read sync the emulators first instead of waiting for the next poll.
