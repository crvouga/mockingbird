# Run against a fleet

Start the harness with the fleet, with one flag: that is the recommended way. It can also run next to a fleet that is already running, or next to emulators you started yourself. It finds the messaging emulators, skips everything else, and serves the devices and the API on one port.

<!-- search: cli serve mockingbird-notifications fleet manifest ready file port namespace poll admin key service flag -->

## With the fleet, in one command

`mockingbird-fleet serve --dashboard` starts the fleet and the harness together. Nothing else to install: `@crvouga/mockingbird-fleet` brings this package with it.

```sh
mockingbird-fleet serve --config mockingbird.json --dashboard
# fleet ready: http://127.0.0.1:9000/__admin/fleet
# dashboard:   http://127.0.0.1:8790
```

`--dashboard-port <n>` picks the port (`0` for a free one), and `"dashboard": true` or `"dashboard": { "port": 8790 }` in the fleet configuration does the same without a flag. The URL is in the ready file and `--ready-json` as `dashboard`, and it stops with the fleet. See [Fleets](../FLEETS.md#dashboard).

## The dashboard

The page has two tabs. **Emulators** is the admin UI of every HTTP emulator the fleet runs, messaging or not (Stripe, Cognito, …): pick one, then its state, clock, faults, journal and checkpoints. **Notifications** is the [devices](DEVICES.md). The Notifications tab counts what arrives while you are on the other one.

`?tab=emulators` and `?tab=notifications` open a tab; every notifications [link](DEVICES.md#links) (`?view=sms&to=…`) still opens the devices. The harness fronts each emulator's admin API on its own port, under `/admin/apis/<name>/`, so the browser needs to reach only the dashboard, and it adds the fleet's admin key to requests that carry none. Anyone who can open the dashboard can therefore change emulator state: it listens on `127.0.0.1` unless you pass `--host`.

`mockingbird-notifications serve` serves the same page and opens on Notifications; `--tab emulators` changes that, and `--no-emulators` leaves the notifications UI alone.

## On its own: install

The rest of this page runs the harness as a separate process, for a fleet that is already running or for emulators outside a fleet.

```sh
npm install -D @crvouga/mockingbird-notifications
```

Node 22 or newer. Install it next to `@crvouga/mockingbird-fleet` and the emulator packages your application uses.

## Start it

Start the fleet as usual, then point the harness at the fleet controller or its ready file:

```sh
mockingbird-fleet serve --config mockingbird.json --ready-file ready.json
mockingbird-notifications serve --manifest ready.json                   # http://127.0.0.1:8790
# or, with the controller URL from the ready file:
mockingbird-notifications serve --fleet http://127.0.0.1:9000/__admin/fleet
```

With `--fleet`, the harness asks the controller what each entry is, so aliases work (`push` with `target: "fcm"`), and it follows every namespace the fleet has. With `--manifest`, the file is re-read on every sync, so a restarted fleet on new ports is picked up. Entries that are not messaging emulators (Stripe, Postgres, …) are skipped.

Emulators outside a fleet can be named directly:

```sh
mockingbird-notifications serve --service twilio=http://127.0.0.1:8798 --service resend=http://127.0.0.1:8794
```

## Flags

| Flag | Meaning |
| --- | --- |
| `--fleet <url>` | Fleet controller `adminBase`. |
| `--manifest <file>` | The fleet's `--ready-file`. |
| `--service <name=url>` | One emulator (repeatable). The name is the service (`twilio`, `fcm`, …) or any alias; an alias is identified from the emulator's health route. |
| `--port`, `--host` | Listener. Default `127.0.0.1:8790`; `--port 0` picks a free port. |
| `--namespace <name>` | Watch this namespace in the background (repeatable). Default `default`, or every fleet namespace with `--fleet`. Any namespace the UI or an API call asks for is watched from then on. |
| `--poll <ms>` | Background poll interval, default 750. `0` reads only when asked. |
| `--admin-key-env <VAR>` | Environment variable with the admin key (default `MOCKINGBIRD_ADMIN_KEY`), sent as `x-mockingbird-admin-key`. |
| `--tab <name>` | The tab the page opens on: `notifications` (default) or `emulators`. |
| `--no-emulators` | Serve the notifications UI alone, without the Emulators tab. |
| `--ready-json` | Print `{"url": …}` once listening. |

## From code

`createServer` from `@crvouga/mockingbird-notifications/server` serves the same harness over `node:http` and takes the CLI's options:

```ts
import { createServer } from "@crvouga/mockingbird-notifications/server"

const server = await createServer({ manifest: "ready.json", port: 0 })
```

Options: `fleet`, `manifest` (a path or an object), `services`, `namespaces`, `pollIntervalMs`, `adminKey`, `adminKeys` (by emulator name), `defaultTab`, `admin` (`false` for no Emulators tab), `port`, `host`. `manifestFile(path)` re-reads a fleet ready file, and `DEFAULT_PORT` is 8790.

## Next

- [Devices](DEVICES.md): what the page at `/` shows.
- [End-to-end tests](END_TO_END_TESTS.md): drive it from a browser test.
- [Fleets](../FLEETS.md): the supervisor the harness reads from.
