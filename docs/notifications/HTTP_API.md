# HTTP API

Every route of a running harness, its filters, and the shape of a notification. The [client](CLIENT.md) and the [devices](DEVICES.md) page use the same API.

<!-- search: http api routes notifications latest wait events server-sent events sse sources namespaces filter json shape record raw -->

## Routes

All routes are `GET`.

| Route | Answer |
| --- | --- |
| `/api/notifications` | `{namespace, version, notifications}`, oldest first (`order=newest` reverses). |
| `/api/notifications/latest` | The newest match, or 404. |
| `/api/notifications/{id}` | One notification. |
| `/api/wait?timeoutMs=&count=` | `{notifications}` once `count` (default 1) match; 408 with what was found after `timeoutMs` (default 10000, at most 120000). |
| `/api/events?namespace=` | Server-sent events: `hello`, `change` (`{added, version}`) and `sources` every 2 s. |
| `/api/sources` | Each emulator: name, service, admin URL, `ok`, last error and count. |
| `/api/namespaces` | Namespaces watched. |

## Filters

| Query | Matches |
| --- | --- |
| `channel` | `sms`, `email` or `push`. |
| `service` | The emulator: `twilio`, `resend`, `fcm`, … |
| `source` | The fleet entry name. |
| `namespace` | Default `default`. |
| `to` | Phone number, mailbox (lower case) or push token. |
| `contains` | Case-insensitive text. |
| `since` | ISO-8601 or epoch milliseconds. |

## A notification

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

An email to several recipients appears once in each mailbox (`to`, `cc` and `bcc`). When Resend forwards to Mailosaur (`--forward-to-inbox`), the Mailosaur copy is hidden so the message shows once.

`createdAt` is on the emulator's clock, so a [frozen or advanced clock](../admin-controls/CLOCK.md) shows here too.
