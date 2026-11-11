# End-to-end tests

Assert on a text, email or push the way the user would see it. The harness UI is built to be driven by Playwright, Cypress or any WebDriver client: it says when it is ready, gives everything a test id, and puts the notification's fields on each element that shows it.

<!-- search: e2e end to end playwright cypress webdriver test id data-testid selectors TEST_IDS ready data-ready screenshot assert one-time code otp -->

## What a test gets

1. **A ready signal.** The root, `[data-testid="notifications-app"]`, gets `data-ready="true"` once its first read is drawn. It also reports `data-count`, `data-version`, `data-view`, `data-namespace`, `data-connected`, `data-sound` and `data-motion`.
2. **A `data-testid` on everything a user can see or press.** `TEST_IDS` names them all, and its typings say what each one marks.
3. **The notification's fields on each element that shows it.** Every bubble, thread, card, row, open email and timeline row carries `data-notification-id`, `data-channel`, `data-service`, `data-source`, `data-to`, `data-from`, `data-status`, `data-created-at` and `data-unread`. A bubble that holds a one-time code also has `data-code`. Use these to find an element by what the test knows instead of by its position.

## Example

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

[`e2e/ui.e2e.ts`](https://github.com/crvouga/mockingbird/blob/main/packages/notifications/e2e/ui.e2e.ts) is a complete, passing example with real Twilio, Resend and FCM emulators.

## Selectors

`selectors` builds the common CSS selectors: `ready()`, `testId(id)`, `notification(id)`, `smsBubble({from, id})`, `smsThread(from)`, `pushNotification(id)`, `emailRow(id)` and `timelineRow(id)`.

| Device | Main test ids | State attributes |
| --- | --- | --- |
| Top bar | `namespace`, `search`, `view-devices`, `view-timeline`, `follow`, `sound-toggle`, `connection`, `source`, `notice`, `toast`, `toast-undo` | `source`: `data-name`, `data-service`, `data-ok`, `data-count`. `connection`: `data-state`. |
| Messages | `sms-device`, `sms-recipient`, `sms-thread` (`-name`, `-preview`, `-time`, `-unread`), `sms-conversation`, `sms-back`, `sms-bubble`, `sms-code`, `sms-menu`, `sms-menu-tapback`, `sms-tapback`, `sms-empty` | `sms-device`: `data-screen` (`threads` or `conversation`), `data-recipient`, `data-thread`. `sms-thread`: `data-pinned`, `data-muted`. |
| Push | `push-device`, `push-recipient`, `push-skin`, `push-group`, `push-group-more`, `push-notification` (`-title`, `-body`, `-app`, `-time`, `-image`, `-data`, `-meta`), `push-clear`, `push-options`, `push-preview`, `push-settings`, `push-clear-all`, `push-empty` | `push-device`: `data-skin` (`ios` or `android`), `data-platform`. `push-notification`: `data-expanded`, `data-app`, `data-stacked`. |
| Mail | `email-device`, `email-recipient`, `email-row` (`-from`, `-subject`, `-snippet`, `-date`, `-star`, `-archive`, `-delete`), `email-open`, `email-subject`, `email-from-name`, `email-from-address`, `email-to`, `email-details`, `email-detail`, `email-body`, `email-text`, `email-attachment`, `email-empty` | `email-device`: `data-screen` (`inbox` or `message`). `email-detail`: `data-field`. `email-attachment`: `data-filename`, `data-content-type`, `data-size`. |
| Timeline | `timeline`, `timeline-row`, `inspector`, `inspector-json`, `inspector-field`, `inspector-close`, `inspector-show-on-device` | `inspector-json` holds the whole record, `raw` included, as JSON. |

Controls are real buttons, selects and inputs with accessible names, so `getByRole` works as well.

## Parallel tests

New arrivals are drawn live, so a test can keep a page open while the app sends. When several tests share a harness, give each one its own [namespace](../admin-controls/NAMESPACES.md) (`?namespace=`) or open a deep link to one recipient: a link with `to=` stays on that recipient instead of following new arrivals. Set `?follow=0` on any other link that should stay put.
