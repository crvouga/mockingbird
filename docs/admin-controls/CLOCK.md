# Clock

Every timestamp an emulator writes reads from its clock. Set it, freeze it or move it, and expiries, retry windows and renewals arrive in milliseconds instead of being waited for.

<!-- search: time travel clock freeze frozen advance set now timestamp date expiry expire auto-advance tick fake timers -->

## Interface

| Carrier | How |
| --- | --- |
| Admin API | `GET /__admin/clock` · `POST /__admin/clock` |
| Request header | `x-mockingbird-time: <instant>` · `x-mockingbird-advance: <duration>` |
| At boot | `adminControls.clock` · `--clock <instant>` · `--freeze` · `--auto-advance <duration>` |
| In process | `runtime.namespaceClock(key?)` · `runtime.clock` |
| Admin page | **Clock** at `/__admin/ui#clock` |

An instant is epoch milliseconds or ISO-8601. A duration is milliseconds or a string: `"250ms"`, `"2s"`, `"15m"`, `"1h"`, `"3d"`.

## Admin page

Open `http://localhost:8787/__admin/ui#clock`.

| Control | Does |
| --- | --- |
| Freeze clock | `POST /__admin/clock` with `{"freeze": true}` or `{"freeze": false}` |
| −1h, +1m, +15m, +1h, +1d | `{"advance": <milliseconds>}` |
| Reset clock | `{"reset": true}` |
| Set an instant, then Set time | `{"set": "<ISO-8601>"}` |
| Auto-advance, then Set auto-advance | `{"autoAdvance": "<duration>"}`. `0` turns it off |
| Virtual time | `PUT /__admin/controls` with `{"virtualTime": true}` or `{"virtualTime": false}`. Waits are spent on this clock |

## Admin API

### `GET /__admin/clock`

```bash
curl localhost:8787/__admin/clock
```

```json
{
  "now": 1893456000000,
  "iso": "2030-01-01T00:00:00.000Z",
  "frozen": true,
  "offsetMs": 0,
  "autoAdvanceMs": 0
}
```

| Field | Meaning |
| --- | --- |
| `now` | The namespace's current time, epoch ms |
| `iso` | The same instant as ISO-8601 |
| `frozen` | True while time does not move on its own |
| `offsetMs` | Milliseconds a running clock is ahead of the base clock. `0` while frozen |
| `autoAdvanceMs` | Milliseconds the clock steps before every vendor request |

### `POST /__admin/clock`

Move the namespace's clock. Every field is optional, and they apply in the order listed.

| Body field | Type | Does |
| --- | --- | --- |
| `reset` | `true` | Drop the namespace's own offset, freeze and auto-advance: follow the base clock again |
| `now` | instant | Move the clock to this instant |
| `advance` | duration | Move the clock by this much. Negative goes back |
| `frozen` | boolean | `true` stops time; `false` lets it run from where it is |
| `autoAdvance` | duration | Step the clock this much before every vendor request. `0` turns it off |

`set` and `freeze` are accepted as older spellings of `now` and `frozen`. Answers the same body as `GET`.

```bash
curl -X POST localhost:8787/__admin/clock -d '{"now": "2030-06-01T00:00:00Z", "frozen": true}'
curl -X POST localhost:8787/__admin/clock -d '{"advance": "15m"}'
```

```json
{
  "now": 1906503300000,
  "iso": "2030-06-01T00:15:00.000Z",
  "frozen": true,
  "offsetMs": 0,
  "autoAdvanceMs": 0
}
```

## Request headers

| Header | Does |
| --- | --- |
| `x-mockingbird-time: <instant>` | Freeze the namespace clock at this instant, before the request is handled |
| `x-mockingbird-advance: <duration>` | Move the namespace clock by this much, before the request is handled |

Both persist, like the admin call they stand for. Sending the same `x-mockingbird-time` on every request of a test pins every one of them to that instant.

```bash
curl -X POST localhost:8787/v1/customers -H 'x-mockingbird-time: 2030-01-01T00:00:00Z' \
  -H 'authorization: Bearer sk_test_mockingbird' -d email=ada@example.com
```

## At boot

```json
{ "clock": { "now": "2030-01-01T00:00:00Z", "frozen": true, "autoAdvance": "1s" } }
```

```bash
npx mockingbird-stripe serve --clock 2030-01-01T00:00:00Z --freeze --auto-advance 1s
```

| Field | Flag | Meaning |
| --- | --- | --- |
| `now` | `--clock <instant>` | Where the clock starts |
| `frozen` | `--freeze` | Start with time stopped |
| `autoAdvance` | `--auto-advance <duration>` | Step before every vendor request |

## In process

```ts
const clock = runtime.namespaceClock("worker-3") // omit the key for "default"
clock.now()            // epoch ms
clock.set(Date.parse("2030-01-01T00:00:00Z"))
clock.advance(15 * 60_000)
clock.freeze()
clock.unfreeze()
clock.reset()          // follow the base clock again
clock.state()          // { now, frozen, offsetMs }

runtime.clock          // the base clock every namespace follows
```

## How the clocks relate

- **Every namespace has its own clock**, `default` included. Moving one never moves another.
- **Each follows the base clock** with an offset and a freeze of its own. The boot `clock` sets the base clock; in process it is `runtime.clock`. Moving the base moves every namespace that has not frozen its own clock.
- **A frozen clock moves only when told to.** That is what makes timestamps reproducible.
- **`autoAdvance` keeps frozen timestamps distinct**: each vendor request steps the clock first, so two records never share an instant. Admin calls do not step it.
- **With [virtual time](LATENCY_AND_TIMEOUTS.md#virtual-time)**, injected waits move the clock too.
- **[Reset](RESET.md)** returns the namespace's clock to boot. A [snapshot](SNAPSHOT_AND_RESTORE.md) restores the instant it was taken at.

An emulator that keeps a schedule (subscription renewals, session expiry) runs it as soon as the namespace's clock is moved, so what came due is visible on the next read.

## Errors

| Status | When |
| --- | --- |
| `400` | `now` is not an instant, `advance` or `autoAdvance` is not a duration, `frozen` or `reset` is not a boolean, or the body has an unknown field |
| `401` | The emulator has an admin key and the request did not carry it |

## Related

- [Checkpoints and branches](CHECKPOINTS_AND_BRANCHES.md): travel through the namespace's state instead of its clock.
- [Latency and timeouts](LATENCY_AND_TIMEOUTS.md): spend waits on this clock with virtual time.
- [Faults](FAULTS.md): `from` and `until` open and close a fault on this clock.
