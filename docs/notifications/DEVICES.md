# Devices

The harness page shows three devices side by side: a phone's Messages app, a push lock screen or notification shade, and a webmail inbox. Each one behaves like the real app, in a generic style with no vendor marks.

<!-- search: ui page devices messages app lock screen notification shade webmail inbox timeline inspector follow new sound motion gestures swipe long press deep link query view namespace -->

## The page

`/` shows the three devices. Each has a recipient picker (phone number, push token, mailbox) that follows the newest arrival unless **Follow new** is off. The **Timeline** tab lists everything in one table; double-click any message, or click a timeline row, to inspect the normalized record and the emulator's raw one. Read state is kept per browser.

The top bar holds the **Namespace** select, a search box that filters by recipient, sender or text, the **Devices** and **Timeline** tabs, **Follow new**, **Sound**, and one count per emulator the harness reads.

## Links

Links open one device, for example for a screenshot in a Playwright test:

| Query | Effect |
| --- | --- |
| `?namespace=worker-3` | Show that namespace. |
| `?view=sms\|push\|email&to=<recipient>` | Show only that device, opened on that recipient (an SMS link opens the newest thread). |
| `?id=<notification id>` | Open that notification on its device. |
| `?view=timeline` | Open the timeline. |
| `?follow=0` | Do not jump to new arrivals. |
| `?sound=1` | Turn arrival sounds on. |

`NotificationClient.link({ id })` builds the link to one notification; see [Client](CLIENT.md).

## Messages

Threads per sender, bubbles, and a one-time code offered above the keyboard.

- Swipe a conversation left for Hide Alerts and Delete, or right for Pin and Unread.
- Swipe the open conversation left to see each message's time.
- Long-press a message for tapbacks and Copy.

## Push

An iOS lock screen or an Android notification shade, chosen from the device token's platform, or by the **Auto / iOS / Android** switch. Each card shows the title, body, image, app, data, badge and sound.

- **iOS:** notifications group by app. Tap a group to open it, swipe a card left for Options and Clear, and long-press it for a preview.
- **Android:** tap a card to expand it, swipe it either way to dismiss it, long-press it for its settings, and use Clear all.

## Mail

An inbox per recipient (to, cc and bcc), the rendered HTML, attachments and headers.

- Hover a row for Archive, Delete and Mark as read, then Undo from the toast.
- Star rows, and open a message to read its HTML.

## Gestures, sound and motion

Every gesture also works with a click or the keyboard. Dismissing, archiving or deleting only hides the message in this browser; the harness keeps every record, and a reload brings it back.

**Sound** is off by default; the top bar's speaker toggles it. New arrivals play a synthesized chime in each platform's style, and phones vibrate where the browser allows.

**Motion:** arrivals, swipes, stacks and screen changes are animated. A viewer's reduced-motion setting turns animation off, and so does the `motion: "reduce"` option of [the embedded UI](EMBED.md).
