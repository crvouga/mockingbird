# @crvouga/mockingbird-service-redis

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

In-process Redis for tests. `createRedis()` is a pure TypeScript RESP store: call commands on
`redis.client()`, or speak RESP to the TCP server (`mockingbird-redis`, or `serve` from
`@crvouga/mockingbird-service-redis/server`). It is not an HTTP API emulator and has no `createRuntime`.
`./server` also exports `serveTarget`, so `serve --config` can boot it: `GET /__admin/health` reports
`service: redis`, and RESP listens on an ephemeral `redis://127.0.0.1:<port>` printed at startup.
`mockingbird-redis` still binds `6379` unless `--port` is set.

Replies follow the Redis command reference for a single standalone node and were spot-checked
against Redis 8.4.0. The advertised version is Redis 7.2.4 so clients do not probe Redis 8 modules.
This package is a work in progress.

## Install

```bash
npm install -D @crvouga/mockingbird-service-redis
```

## Usage

```ts
import { Redis } from "ioredis"
import { createRedis, manualClock } from "@crvouga/mockingbird-service-redis"
import { serve } from "@crvouga/mockingbird-service-redis/server"

// Test setup: an emulator on a manual clock, listening on a free port. `as never` is needed
// because the two entry points bundle separate declarations of the `Redis` type.
const emulator = createRedis({ clock: manualClock(1_700_000_000_000) })
const server = await serve(emulator as never, { port: 0 })

// Application code: the ioredis client it already uses, connected to the emulator.
const redis = new Redis({ host: server.host, port: server.port })
console.log(await redis.set("lock", "token", "PX", 1000)) // OK

// Test control: expire the lock without sleeping.
emulator.advance(1000)
console.log(await redis.get("lock")) // null

await redis.quit()
await server.close()
```

Two `createRedis()` instances never share keys. `SELECT` isolates logical databases 0–15 inside
one instance. `emulator.advance(ms)` moves an injected clock. `emulator.inspect()`,
`emulator.fault()`, `emulator.pauseConsumers()`, `emulator.reset()`, and `emulator.waiterCount()`
are the test controls.

`ioredis` connects to the TCP server unchanged. Cluster `MOVED` / `ASK` is not implemented:
`CLUSTER` and `READONLY` answer that cluster support is disabled.

`mockingbird-redis serve --config mockingbird.json` supervises mixed HTTP/Postgres/Redis fleets.
See [fleet configuration and controls](../../../docs/FLEETS.md) for ephemeral discovery, namespace
endpoints, readiness, shutdown and coordinated state controls.

## API

- `createRedis(options?)` returns a `Redis` instance.
- `Redis` holds the store, the clock, and the test controls (`client`, `advance`, `fault`, `inspect`, `pauseConsumers`, `reset`, `waiterCount`, `close`).
- `RedisClient` is one connection: `call`, `raw`, `pipeline`, `quit`, `onPush`, and `protocol`.
- `RedisPipeline` queues `call`s and runs them in `exec`.
- `RedisConnectionError` is a dropped connection, a timeout fault, or a closed server.
- `RedisReplyError` is a Redis error reply raised by `call`.
- `manualClock(start)` moves only when `advance` is called. `wallClock` follows `Date.now()`.
- `encodeReply(reply, protocol)` writes a RESP2 or RESP3 frame.

## Deliberately not modelled

- Cluster redirects (`MOVED`, `ASK`) and replica replication. `ROLE` stays `master`.
- Redis 8 modules, and the full Redis command set. `ACL SETUSER`/`GETUSER`/`DELUSER`/`CAT`/`LOG`/
  `GENPASS`/`DRYRUN`/`LOAD`/`SAVE`, `MEMORY DOCTOR`/`STATS`/`MALLOC-STATS`, `COMMAND GETKEYSANDFLAGS`
  and `COMMAND HELP` return an explicit "not supported by the Mockingbird Redis emulator" error.
- Best guess, not oracle-verified: `MEMORY USAGE` byte counts, `OBJECT ENCODING` thresholds, the
  `HSCAN`/`SSCAN`/`ZSCAN` cursor of collections too large for a compact encoding, and a `SLOWLOG`
  that never records. `MONITOR` is supported; see [SUPPORT.md](SUPPORT.md).
- Lua coroutines (`coroutine.*` exists and raises an explicit "not supported" error), `redis.setresp(3)`
  and a script time limit (`SCRIPT KILL` cannot interrupt a script that never returns). The rest of
  Lua 5.1 as Redis ships it (standard libraries, `cjson`, `cmsgpack`, `struct`, `bit`) is implemented
  and differentially checked against redis-server 8.4.0; see [SUPPORT.md](SUPPORT.md). BullMQ 5.76.2
  queue/worker flows are covered by the public-client suite.
- `XADD` / `XTRIM` `MAXLEN ~` trims exactly.
- Set members are returned in byte order so results stay deterministic.
