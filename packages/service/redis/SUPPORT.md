# Redis (Mockingbird subset) — command support

Work in progress. Replies are checked against the Redis command reference and local Redis 8.4.0
spot checks. The server reports `redis_version` 7.2.4 and `redis_mode:standalone`.

| area | commands | notes |
| --- | --- | --- |
| connection | `AUTH`, `HELLO`, `PING`, `QUIT`, `RESET`, `SELECT`, `CLIENT`, `INFO`, `ECHO` | RESP2 and RESP3. `HELLO 3` switches before its map reply. |
| strings | `GET`, `SET`, `MGET`, `MSET`, `INCR`, `DECR`, `APPEND`, `GETSET`, `GETDEL`, `GETEX`, `SETBIT`, `GETBIT`, `BITCOUNT` | `NX` `XX` `EX` `PX` `EXAT` `PXAT` `KEEPTTL` `GET`. `BITCOUNT` takes `BYTE`/`BIT` ranges. |
| HyperLogLog | `PFADD`, `PFCOUNT`, `PFMERGE` | Exact counts: best guess, see #753 below. |
| expiration | `EXPIRE`, `PEXPIRE`, `EXPIREAT`, `PEXPIREAT`, `TTL`, `PTTL`, `PERSIST` | Injected clock. Negative `EXPIRE` deletes an existing key. |
| keys | `DEL`, `EXISTS`, `TOUCH`, `TYPE`, `SCAN`, `KEYS`, `RENAME`, `FLUSHDB`, `FLUSHALL` | `SCAN` cursor is a bulk string. |
| hashes | `HSET`, `HGET`, `HMGET`, `HGETALL`, `HDEL`, `HINCRBY` | |
| lists | `LPUSH`, `RPUSH`, `LPUSHX`, `RPUSHX`, `LPOP`, `RPOP`, `LRANGE`, `LPOS`, `LMOVE`, `BLPOP`, `BRPOP` | Blocking waits release the command queue; LPOS supports RANK, COUNT and MAXLEN. |
| sets | `SADD`, `SREM`, `SMEMBERS`, `SISMEMBER`, `SPOP`, `SINTER`/`SUNION`/`SDIFF` and their `STORE` forms, `SINTERCARD` | Members are ordered bytewise. |
| sorted sets | `ZADD`, `ZRANGE` (`BYSCORE`, `BYLEX`, `REV`, `LIMIT`), `ZRANGESTORE`, `ZRANGEBYLEX`, `ZREVRANGEBYLEX`, `ZLEXCOUNT`, `ZREMRANGEBYLEX`, `ZPOPMIN`, `BZPOPMIN`, `ZINCRBY`, `ZRANK ... WITHSCORE`, `ZUNION`/`ZINTER`/`ZDIFF` and their `STORE` forms, `ZINTERCARD`, `ZRANDMEMBER` | Scores print as Redis 7 does (`1e+20`, `1.5e-7`). RESP3 scores are doubles and `WITHSCORES` replies are `[member, score]` pairs. |
| streams | `XADD`, `XRANGE`, `XREVRANGE`, `XREAD`, `XGROUP`, `XREADGROUP`, `XACK`, `XPENDING`, `XCLAIM`, `XAUTOCLAIM` | Consumer-group pending entries and claim. `XRANGE`/`XREVRANGE` take `(` exclusive and incomplete (`ms`) IDs. |
| transactions | `MULTI`, `EXEC`, `DISCARD`, `WATCH`, `UNWATCH` | A watched key change makes `EXEC` a null array. |
| pub/sub | `SUBSCRIBE`, `UNSUBSCRIBE`, `PSUBSCRIBE`, `PUBLISH`, `PUBSUB`, `SSUBSCRIBE`, `SUNSUBSCRIBE`, `SPUBLISH` | Sharded channels on one node. Keyspace notifications (`notify-keyspace-events`), see below. |
| scripts | `EVAL`, `EVALSHA`, `EVAL_RO`, `EVALSHA_RO`, `SCRIPT LOAD`, `SCRIPT EXISTS`, `SCRIPT FLUSH`, `FUNCTION LOAD`/`LIST`/`DELETE`/`FLUSH`/`STATS`, `FCALL`, `FCALL_RO` | Lua 5.1 with Redis's libraries (see "Lua scripting" below). |
| replication | `WAIT` | No replicas: answers `0` at once. |
| cluster | `CLUSTER`, `READONLY`, `ASKING` | Single node: cluster support disabled. |

BullMQ 5.76.2 is exercised through unmodified Queue, Worker, QueueEvents and FlowProducer clients:
completion, delays/backoff, retry and unrecoverable errors, explicit delayed transitions,
deduplication/unique IDs, auto removal, rate limits, repeatable schedulers, global concurrency, lock ownership/renewal, stalled recovery,
parent dependencies, and SCRIPT FLUSH/NOSCRIPT reload. Both ioredis 5.9.2 and 5.11.1 are tested.
See `test/bullmq.sdk.test.ts`. `bun run parity:bullmq` runs the identical public-client contract
against the emulator and an installed local `redis-server` (verified with Redis 8.4.0).

Out of scope: Redis Cluster and Redis 8 modules. Lua coroutines and the other limits listed under
"Lua scripting" are the only intentional gaps in the script runtime.

## Lua scripting (#497, #504, #505)

`EVAL`/`EVALSHA` run a Lua 5.1 interpreter (`src/lua/`). A script is parsed once and compiled to a
tree of closures, cached by its SHA-1; `EVALSHA` of a cached script costs the same however long its
text is, and a loop of 10,000 additions runs in well under a millisecond. Behavior below was
compared against redis-server 8.4.0 by running the same scripts on both (about 600 one-off scripts:
base library, `string` patterns and `format`, `table`, `math`, `bit`, `struct`, `cjson`, `cmsgpack`,
`redis.*`, error messages) and is pinned in `test/redis.lua.test.ts`.

| Area | Behavior |
| --- | --- |
| Libraries | `string` (`find`, `match`, `gmatch`, `gsub`, `format` with flags, width and precision, `rep`, `sub`, `byte`, ...), `table` (`sort`, `getn`, `maxn`, `foreach`, ...), `math`, `os.clock`, `bit`, `struct`, `cjson`, `cmsgpack` (`pack`, `unpack`, `unpack_one`, `unpack_limit`), `loadstring`, `pcall`/`xpcall`/`error`/`assert`, `setmetatable`/`getmetatable`/`rawget`/`rawset`, `select`, `unpack`, `tonumber` with a base. `table.unpack` does not exist, as in Redis. |
| Globals | Read-only like Redis 7+: assigning a global or changing a library table raises `Attempt to modify a readonly table`; reading an unknown global raises `Script attempted to access nonexistent global variable 'x'`. |
| Replies | A returned Lua number is truncated to an integer reply (`3.7` is `3`); a table ends at its first `nil`; `true` is `1` and `false` is a null; `{ok=}` and `{err=}` tables are status and error replies. `redis.call` returns status replies as `{ok=}` tables and raises error replies as `{err=}` tables; `redis.pcall` returns them. |
| Errors | `ERR user_script:LINE: message script: <sha>, on @user_script:LINE.` as Redis 7+ prints them, with Lua's variable names in messages (`attempt to index local 'a' (a nil value)`). Compile errors reply `ERR Error compiling script (new function): ...` and are not cached; `SCRIPT LOAD` rejects them. |
| `redis.call` from a script | Unknown commands and wrong argument counts use Redis's script wording; `EVAL`/`EVALSHA` (and `FCALL`) from inside a script are refused; arguments must be strings or numbers. |

Known differences (the emulator does not model these; none was observed to matter for BullMQ):

- `coroutine.*` exists (so `type(coroutine)` is `"table"`) but each function raises an explicit
  "not supported by this emulator's Lua runtime" error. The evaluator is not resumable.
- `redis.setresp(3)` raises an explicit error; scripts always see RESP2 replies.
- There is no script time limit: a script that never returns blocks the emulator, and `SCRIPT KILL`
  cannot reach it (Redis would answer `BUSY` to other clients after `busy-reply-threshold`).
- Best guess, not oracle-verified: `math.random` is a deterministic generator (same sequence in
  every process unless `math.randomseed` is called), where redis-server's differs per run.
- `string.format('%x', -1)` prints the 64-bit two's complement; redis-server's answer for negative
  unsigned conversions depends on the host CPU (0 on arm64).
- `error(msg, 2)` prefixes the line of the `error` call, not of the function's caller. `pcall()` with
  no arguments returns `false, "attempt to call a nil value"` (Redis's message names a boolean).
- `tostring(table)` addresses are not Redis's; `cjson.encode_keep_buffer` and
  `cjson.encode_invalid_numbers`/`decode_invalid_numbers` accept only their default value.
- Object key order in `cjson.encode` and `pairs` is insertion order (Redis's is hash order).

## Monitoring, introspection and the wider command set (#498, #499, #507)

Every command below also appears in `COMMAND INFO` with metadata captured from redis-server 8.4.0.
Behaviors observed in the reports against redis-server 8.4.0 are implemented as reported; anything
else is labelled **best guess, not oracle-verified** (official command reference semantics, no live
run). Tests: `test/redis.commands.test.ts`.

| command | status |
| --- | --- |
| `MONITOR` | Supported. The connection replies `+OK`, then receives `+<sec>.<micros> [<db> <addr>] "name" "arg" ...` for every command other connections run (name as typed, `sdscatrepr` quoting, `<db>` is the caller's database, `lua` for calls made by a script, after its `eval` line). `AUTH`/`HELLO ... AUTH` credentials show as `(redacted)`; admin commands, unknown commands, arity errors and commands queued in `MULTI` are not shown (as Redis). A monitoring connection cannot run keyspace commands (`ERR Replica can't interact with the keyspace`). Timestamps follow the injected clock. |
| `MEMORY USAGE key [SAMPLES n]` | Best guess: nil for a missing key, otherwise a deterministic positive size (24 + key length + value bytes + a fixed per-element overhead). Grows with the value but does not match Redis's allocator bytes (`SET mk value` is `32` on Redis 8.4.0). `MEMORY PURGE` is `OK`. `MEMORY DOCTOR`, `STATS`, `MALLOC-STATS`, `HELP` return an explicit `ERR MEMORY <sub> is not supported by the Mockingbird Redis emulator` (emulator limitation, not a Redis error). |
| `OBJECT IDLETIME key` | Seconds since the key was last written or read (not by `OBJECT`/`TYPE`-style peeks), tracked on the injected clock, so `emulator.advance(5000)` makes it `5`; nil for a missing key. Whole seconds from a millisecond clock, whereas Redis uses a coarse 1-second LRU clock. |
| `OBJECT FREQ key` | The report's exact LFU error (the emulator has no LFU policy); nil for a missing key. |
| `OBJECT ENCODING key`, `REFCOUNT key`, `HELP` | Encoding names (`int`, `embstr`, `raw`, `listpack`, `quicklist`, `intset`, `hashtable`, `skiplist`, `listpackex`, `stream`) use Redis 8.4.0's default thresholds (best guess beyond `listpack` for a small list, which the report observed). `REFCOUNT` is always `1`. |
| `HSCAN`, `SSCAN`, `ZSCAN` | `[cursor, [...]]` with `MATCH`, `COUNT`, and `NOVALUES` for `HSCAN`. A compact (listpack/intset) collection is returned whole with cursor `0`, as Redis does; larger ones are paged by element offset, `COUNT` per call (default 10), so a full walk visits each element once. The cursor value is a best guess: Redis's reverse-binary hash-table cursor is not reproduced. Set members are in byte order, zset members in score order. Missing key is `["0", []]`. |
| `ZUNIONSTORE` | Full: `WEIGHTS`, `AGGREGATE SUM\|MIN\|MAX`, plain sets as score 1, empty result deletes the destination. |
| `LMPOP` | Full: `LEFT`/`RIGHT`, `COUNT`, null when every list is empty. |
| `BLMOVE`, `BRPOPLPUSH` | Full: block (releasing the command queue) until an element arrives or the injected clock passes the timeout; `0` waits forever; reply null on timeout. |
| `MSETNX`, `COPY`, `EXPIRETIME`, `PEXPIRETIME` | Full: `COPY` supports `DB n` and `REPLACE`, deep-copies any type and keeps the TTL. |
| `HEXPIRE` | Full, with `HPEXPIRE`, `HEXPIREAT`, `HPEXPIREAT`, `HTTL`, `HPTTL`, `HEXPIRETIME`, `HPEXPIRETIME`, `HPERSIST`, `NX\|XX\|GT\|LT`, per-field result codes. |
| `SLOWLOG` | `GET` is always empty, `LEN` is `0`, `RESET` is `OK`, `HELP` lists the subcommands. The emulator has no wall-clock command latency to threshold on, so nothing is ever slow (an emulator model, not an observed Redis log). |
| `ACL WHOAMI`, `USERS`, `LIST` | Describe the users given to `createRedis` (`password`, `users`): `default` plus any extra, `LIST` shows `nopass` or the SHA-256 of the password and `-@write` for `readOnly` users. |
| `ACL SETUSER`, `GETUSER`, `DELUSER`, `CAT`, `LOG`, `GENPASS`, `DRYRUN`, `LOAD`, `SAVE`, `HELP` | **Unsupported**: `ERR ACL <sub> is not supported by the Mockingbird Redis emulator`. There is no defensible deterministic model for a full ACL rule engine; users are fixed at construction and nothing changes. |
| `COMMAND`, `COMMAND COUNT`, `LIST` (incl. `FILTERBY`), `INFO`, `DOCS`, `GETKEYS` | Metadata for the commands the emulator implements (captured from redis-server 8.4.0 by `scripts/command-table.ts`). `COMMAND COUNT` is the number of those commands, not Redis's `272`. `GETKEYS` handles fixed key specs plus `EVAL`, `ZUNIONSTORE`-style `numkeys`, `LMPOP` and `XREAD`. Sub-command entries and key specifications inside `INFO` are empty arrays. |
| `COMMAND GETKEYSANDFLAGS`, `COMMAND HELP` | **Unsupported**, explicit `ERR COMMAND <sub> is not supported by the Mockingbird Redis emulator`. |

## Issue #753: XREVRANGE, RESP3 scores, keyspace notifications, missing commands

Unless marked **best guess, not oracle-verified**, every behavior below was compared byte for byte
against redis-server 7.4.12 (the `redis:7.4` Docker image), and the `COMMAND INFO` rows of the new
commands were captured from redis-server 8.4.0 (`scripts/command-table.ts`). Tests:
`test/redis.issue-753.test.ts`; `bun run parity` replays the deterministic commands against
`REDIS_URL` (passes against both 7.4.12 and 8.4.0).

| behavior | evidence |
| --- | --- |
| `XREVRANGE key end start [COUNT n]` returns newest first; `XRANGE`/`XREVRANGE` accept `(` exclusive and incomplete IDs, reject invalid IDs (`ERR Invalid stream ID ...`, `ERR invalid start/end ID for the interval`), and `COUNT 0` (or negative) is a null array | oracle |
| After `HELLO 3`: `ZRANGE`/`ZREVRANGE`/`ZRANGEBYSCORE`/`ZREVRANGEBYSCORE`/`ZUNION`/`ZINTER`/`ZDIFF`/`ZRANDMEMBER ... WITHSCORES` and `ZPOPMIN`/`ZPOPMAX` with a count reply `[member, double]` pairs; `ZPOPMIN`/`ZPOPMAX` without a count, `BZPOPMIN`/`BZPOPMAX` stay flat with a double score; `ZSCORE`, `ZMSCORE`, `ZINCRBY`, `ZADD INCR`, `ZRANK ... WITHSCORE` reply doubles. RESP2 and Lua scripts keep flat bulk-string replies | oracle |
| `HGETALL` and `CONFIG GET` reply RESP3 maps after `HELLO 3` | oracle |
| Scores print as Redis's `d2string` (integers within ±2^62, otherwise shortest digits laid out by `fpconv_dtoa`: `1e+20`, `1.5e-7`, `0.00001`) | oracle; Redis's grisu digits can be one digit longer than the shortest round trip (`1e23` prints `99999999999999990000000` there, `1e+23` here) |
| `TOUCH`, `LPUSHX`, `RPUSHX`, `SUNIONSTORE`, `SINTERSTORE`, `SDIFFSTORE`, `SINTERCARD`, `ZINTERSTORE`, `ZDIFFSTORE`, `ZUNION`, `ZINTER`, `ZDIFF`, `ZINTERCARD`, `ZRANGESTORE`, `ZRANGEBYLEX`, `ZREVRANGEBYLEX`, `ZLEXCOUNT`, `ZREMRANGEBYLEX`, `ZRANGE ... BYLEX`, `ZRANK ... WITHSCORE`, `SETBIT`, `GETBIT`, `BITCOUNT`, `WAIT` (0 at once, no replicas), `EVAL_RO`/`EVALSHA_RO` (write commands raise `Write commands are not allowed from read-only scripts.`), `SPUBLISH`/`SSUBSCRIBE`/`SUNSUBSCRIBE`, `PUBSUB SHARDCHANNELS`/`SHARDNUMSUB`, and their error replies | oracle |
| `ZRANDMEMBER` member choice | random in Redis; the emulator draws from its seeded generator (`createRedis({ seed })`), so the choice differs from Redis but repeats run to run |
| `PFADD`, `PFCOUNT`, `PFMERGE`: replies (`1`/`0`, `OK`), `TYPE` string, the `WRONGTYPE Key is not a valid HyperLogLog string value.` error and keyspace events | oracle |
| `PFCOUNT` is exact, and `GET`/`STRLEN` of an HLL key show this emulator's encoding (`HYLL` magic, then the members), not Redis's registers | **best guess, not oracle-verified**: Redis's estimate has a 0.81% standard error, so the exact count is what an approximate count converges to for small sets |
| `FUNCTION LOAD [REPLACE]` (metadata, compile and registration errors, `Function ... already exists`, `No functions registered`), `FCALL`/`FCALL_RO` (`Function not found`, key-count errors, `no-writes` flag, `*_ro` refusal, `user_function:N` error positions), `FUNCTION LIST [WITHCODE] [LIBRARYNAME]` (RESP2 shape), `DELETE`, `FLUSH` | oracle |
| `FUNCTION LIST` order (load order; Redis's is hash order), `FUNCTION LIST` flags as an array (Redis sends a RESP3 set), `FUNCTION KILL` answering `NOTBUSY`, `FUNCTION STATS` | **best guess, not oracle-verified** |
| `FUNCTION DUMP`, `RESTORE`, `HELP` | **Unsupported**: explicit `ERR FUNCTION <sub> is not supported by the Mockingbird Redis emulator` (emulator limitation, not a Redis error). Libraries are not part of `snapshot()` / fleet archives and `reset()` drops them. |

### Keyspace notifications

`CONFIG SET notify-keyspace-events <classes>` accepts Redis's class characters (`K E g $ l s h z x e
t m d n A`), rejects anything else with Redis's `Invalid event class character` error, and
`CONFIG GET` prints the flags normalised exactly as Redis does (`Ex` reads back `xE`, `KEA` reads
back `AKE`, and `n` is dropped from the text next to `A` though still active). `CONFIG SET` takes
several parameter/value pairs at once and rejects a duplicate. The setting starts empty (nothing
published) and `emulator.reset()` clears it. Events are published as Redis does,
on `__keyspace@<db>__:<key>` (message: the event) and `__keyevent@<db>__:<event>` (message: the
key), to `SUBSCRIBE` and `PSUBSCRIBE` alike, and from commands inside `MULTI`/`EXEC` and scripts.

Expiry (`x`): a key whose TTL passes publishes `expired` when the injected clock moves past it
(`emulator.advance(ms)` delivers the event synchronously, before `advance` returns), when a command
touches it, or, on the wall clock, within about 100 ms (a timer runs only while `x` events are
enabled, like Redis's active-expiry cycle). Eviction under `allkeys-lru` publishes `evicted` (`e`).

Events published, observed against redis-server 7.4.12 command by command (including which no-op
calls publish nothing, e.g. `SET NX` on an existing key, a `ZADD` that changes nothing, an empty
`SINTERSTORE`, an `XTRIM` that trims nothing): `set`, `expire`, `persist`, `del`, `incrby`,
`incrbyfloat`, `append`, `setrange`, `setbit`, `rename_from`/`rename_to`, `copy_to`, `new`;
`lpush`, `rpush`, `lpop`, `rpop`, `lset`, `linsert`, `lrem`, `ltrim` (including `LMOVE`,
`RPOPLPUSH`, `LMPOP` and served `BLPOP`/`BRPOP`/`BLMOVE`, push before pop); `sadd`, `srem`, `spop`,
`sinterstore`, `sunionstore`, `sdiffstore`; `hset`, `hdel`, `hincrby`, `hincrbyfloat`; `zadd`,
`zincr`, `zrem`, `zpopmin`, `zpopmax`, `zremrangebyscore`, `zremrangebyrank`, `zremrangebylex`,
`zunionstore`, `zinterstore`, `zdiffstore`, `zrangestore`; `xadd`, `xtrim`, `xdel`,
`xgroup-create`, `xgroup-setid`, `xgroup-destroy`, `xgroup-createconsumer`,
`xgroup-delconsumer`; `pfadd`; `expired`; `evicted`. A blocked client served by a write publishes
its pop after the write's own event, as Redis serves it after the command.

Not published (the class is accepted, nothing is sent): key-miss events (`m`, `keymiss`), module
events (`d`), hash-field expiry events (`hexpire`, `hpersist`, `hexpired`), `xgroup-createconsumer`
for a consumer `XREADGROUP` creates implicitly, `XCLAIM`/`XAUTOCLAIM`/`XACK` events, and events for
commands the emulator does not implement (`MOVE`, `SORT ... STORE`, `RESTORE`, ...). The `new`
event for a key is published before the command's own event; its position relative to `expired`
events of other keys is a best guess.

## Transports (#698)

The RESP server runs over TCP (`serve` from `/server`, Node and Bun) or over any injected
connection (`createRespServer` from `/transport`, no `node:` import: browser, worker, edge). Both
paths run the same session code, so blocking commands, `MULTI`, pub/sub and `CLIENT` behave the
same; a closed stream releases the session as a closed socket does. `test/redis.transport.test.ts`
drives it with unmodified ioredis over in-memory web streams and over a Node `Duplex`. Not a
vendor behaviour, so there is no oracle comparison; the in-process transport is a Mockingbird
feature.

## Fleet controls

The fleet adapter supports dynamic namespace listeners, finite numeric seeds, boot/reset clocks,
connection admission quotas, private pre-ready seeding listeners, bounded key/type/TTL inspection,
and portable `mockingbird.redis/v1` archives. Binary values, Maps, bigint stream ids, Lua scripts,
random state, consumer pause state and queued/delayed BullMQ work survive process replacement.
Live blocked/active work must drain before capture. Fleet latency/fault profiles are unsupported for
RESP children and are rejected explicitly. See [Fleets](../../../docs/FLEETS.md) and the adapter's
`fleet.management.test.ts` acceptance suite (real ioredis clients).

## Parity notes (checked byte-for-byte against redis-server 8.4.0)

- `SET EX|PX|EXAT|PXAT`, `SETEX` and `PSETEX` reject a zero, negative or overflowing expiry with
  `ERR invalid expire time in '<cmd>' command` and leave the existing value alone. A relative
  expiry whose `now + ms` passes 2^63 is accepted and the key stays alive (PTTL about `ms`), as
  Redis 8.4.0 does; `PEXPIRETIME` of such a key is not modelled.
- `SETNX` replies `1` or `0`. `TTL` is `PTTL` rounded to the nearest second, halves up.
- `SCAN ... TYPE <type>` filters by `TYPE` (composes with `MATCH` and `COUNT`); an unknown type is an empty page.
- `KEYS` and `SCAN MATCH` use Redis' glob rules: only `^` negates (`[!b]` is the literal `!` or `b`),
  an unclosed class runs to the end of the pattern, and range bounds are unordered (`[c-b]` is `[b-c]`).
- `INFO` reports the real listening port in `tcp_port`, a live `uptime_in_seconds`, and synthetic but
  well-formed memory, client, CPU and commandstats fields (values are not real measurements).
- RESP framing errors (`invalid bulk length`, `invalid multibulk length`, `expected '$', got '<c>'`,
  `unbalanced quotes in request`) reply `-ERR Protocol error: ...` and close the connection; a null or
  empty array is a no-op.
