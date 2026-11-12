# Notifications

See every SMS, WhatsApp message, email, push and chat message your application sends, the way the person receiving it would: on a phone's Messages app, an iOS lock screen or Android notification shade, a webmail inbox, and a team chat window. The notifications harness reads the Twilio, Resend, FCM, SES, SNS, Customer.io, Mailosaur, Slack and Cognito emulators your app already sends through, and gives tests the same messages through a JSON API and a small client.

<!-- search: notifications harness sms text message email inbox push fcm lock screen notification shade twilio resend ses sns customer.io mailosaur slack chat channel whatsapp block kit webhook tabs one-time code otp verify e2e playwright screenshot outbox messages app webmail -->

The recommended way to run it is with a [fleet](FLEETS.md). One flag starts it and puts it next to every emulator's admin UI, on one page with an **Emulators** tab and a **Notifications** tab. `@crvouga/mockingbird-fleet` brings the harness with it, so there is nothing more to install:

```sh
npx mockingbird-fleet serve --config mockingbird.json --dashboard       # dashboard: http://127.0.0.1:8790
```

To watch a fleet that is already running, or emulators you started yourself, run the harness on its own:

```sh
npm install -D @crvouga/mockingbird-notifications
npx mockingbird-notifications serve --manifest ready.json               # http://127.0.0.1:8790
```

The harness only reads. It sends `GET` requests to each emulator's admin routes and never changes emulator state, so it can watch any fleet, any namespace, while your tests run. (The Emulators tab is each emulator's own admin UI, which does change state when you use it.) It is one package, `@crvouga/mockingbird-notifications`, with a CLI, a Node server, an in-process harness, a browser UI you can mount in your own page, and an HTTP client for tests.

## Try it

The [lab ordering example](https://mockingbird.chrisvouga.dev/examples/medical-testing) mounts the harness as its **Notifications** tab. Place an order and the payment receipt, the results-ready text and the push alert arrive on the devices, with nothing running outside the browser tab.

## Channels

| Channel | Emulators read | Shown as |
| --- | --- | --- |
| SMS | Twilio (Messages and Verify codes), Amazon SNS (direct `PhoneNumber` and `sms` topic subscribers), Customer.io, Mailosaur | Messages app: threads per sender, bubbles, one-time code suggestion |
| WhatsApp | Twilio (Messages to a `whatsapp:` address, and Verify with `Channel=whatsapp`) | The same phone, as a WhatsApp chat. The channel is `sms` with `sms.via: "whatsapp"`; `to` is the bare number |
| Email | Resend, Amazon SES (`SendEmail` and MIME `SendRawEmail`), Amazon SNS (`email` / `email-json` subscribers), Customer.io, Mailosaur, Twilio Verify email | Webmail: inbox per recipient (to, cc, bcc), rendered HTML, attachments, headers |
| Push | Firebase Cloud Messaging | iOS lock screen or Android shade, chosen from the device token's platform |
| Chat | Slack (`chat.postMessage`, `chat.postEphemeral` and incoming webhooks) | Team chat window: a channel list, bot messages with mrkdwn, Block Kit blocks, attachments and reactions |

The device art is generic: no vendor logos. On a narrow screen the devices become tabs, one at a time; see [Devices](notifications/DEVICES.md#channel-tabs).

## Pages

| I want to | Page |
| --- | --- |
| Point the harness at my fleet or my emulators | [Run against a fleet](notifications/RUN_AGAINST_A_FLEET.md) |
| See the emulators' admin UI and the notifications on one page | [Run against a fleet](notifications/RUN_AGAINST_A_FLEET.md#the-dashboard) |
| Look at what was sent, on each device | [Devices](notifications/DEVICES.md) |
| Assert on a message in Playwright or Cypress | [End-to-end tests](notifications/END_TO_END_TESTS.md) |
| Read messages from a test without a browser | [Client and in-process harness](notifications/CLIENT.md) |
| Show the devices inside my own app | [Embed the UI](notifications/EMBED.md) |
| Call the harness over HTTP | [HTTP API](notifications/HTTP_API.md) |
| Look up an export, or what is not covered | [Reference](notifications/REFERENCE.md) |

## How it fits

The emulators keep every message they accept: Twilio's Messages, Resend's emails, FCM's sends, Slack's posts. The harness polls those records (750 ms by default), turns each into one shape (`channel`, `to`, `from`, `preview`, and an `sms`, `email`, `push` or `chat` body), and keeps the emulator's own record as `raw`. Every read syncs first, so a message whose send finished before the read started is always in the answer.

A [fleet](FLEETS.md) is the usual source: the harness asks the fleet controller what each entry is and follows every [namespace](admin-controls/NAMESPACES.md) it has. Parallel test workers that each send under their own namespace get their own inbox and phone.
