# Reference

Every export of `@crvouga/mockingbird-notifications`, and what the harness does not show.

<!-- search: reference api exports createNotificationHarness NotificationClient matches parseMime SERVICE_KINDS TEST_IDS selectors mountNotifications createApp STYLES createServer not covered limitations -->

## Exports

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

The package's [README](https://github.com/crvouga/mockingbird/tree/main/packages/notifications#readme) is the same material in one file.

## Not covered

- Customer.io renders templates on its side and the emulator keeps no body, so its email shows the template id and `message_data`. In-app (`inbox_message`) sends are not shown.
- SNS mobile push (platform endpoints) is not emulated, and SNS topic subscribers are matched by topic only.
- Twilio MMS media is not in the emulator's outbox, so bubbles show text only.
- Replying from a device. The harness shows what was sent; inbound traffic goes through each emulator's own admin routes.

## Develop

```sh
bun run --cwd packages/notifications dev        # a fleet of every messaging emulator, sample traffic, harness on :8790
bun run --cwd packages/notifications e2e        # the browser tests (bunx playwright install chromium first)
bun run --cwd packages/notifications storybook  # every UI state, from fixtures
```
