# Redis (Mockingbird subset) — command support

Work in progress. Replies are checked against the Redis command reference and local Redis 8.4.0
spot checks. The server reports `redis_version` 7.2.4 and `redis_mode:standalone`.

| area | commands | notes |
| --- | --- | --- |
| connection | `AUTH`, `HELLO`, `PING`, `QUIT`, `RESET`, `SELECT`, `CLIENT`, `INFO`, `ECHO` | RESP2 and RESP3. `HELLO 3` switches before its map reply. |
| strings | `GET`, `SET`, `MGET`, `MSET`, `INCR`, `DECR`, `APPEND`, `GETSET`, `GETDEL`, `GETEX` | `NX` `XX` `EX` `PX` `EXAT` `PXAT` `KEEPTTL` `GET`. |
| expiration | `EXPIRE`, `PEXPIRE`, `EXPIREAT`, `PEXPIREAT`, `TTL`, `PTTL`, `PERSIST` | Injected clock. Negative `EXPIRE` deletes an existing key. |
| keys | `DEL`, `EXISTS`, `TYPE`, `SCAN`, `KEYS`, `RENAME`, `FLUSHDB`, `FLUSHALL` | `SCAN` cursor is a bulk string. |
| hashes | `HSET`, `HGET`, `HMGET`, `HGETALL`, `HDEL`, `HINCRBY` | |
| lists | `LPUSH`, `RPUSH`, `LPOP`, `RPOP`, `LRANGE`, `LPOS`, `LMOVE`, `BLPOP`, `BRPOP` | Blocking waits release the command queue; LPOS supports RANK, COUNT and MAXLEN. |
| sets | `SADD`, `SREM`, `SMEMBERS`, `SISMEMBER`, `SPOP` | Members are ordered bytewise. |
| sorted sets | `ZADD`, `ZRANGE`, `ZPOPMIN`, `BZPOPMIN`, `ZINCRBY` | Integer scores encode without a trailing `.0`. |
| streams | `XADD`, `XREAD`, `XGROUP`, `XREADGROUP`, `XACK`, `XPENDING`, `XCLAIM`, `XAUTOCLAIM` | Consumer-group pending entries and claim. |
| transactions | `MULTI`, `EXEC`, `DISCARD`, `WATCH`, `UNWATCH` | A watched key change makes `EXEC` a null array. |
| pub/sub | `SUBSCRIBE`, `UNSUBSCRIBE`, `PSUBSCRIBE`, `PUBLISH`, `PUBSUB` | |
| scripts | `EVAL`, `EVALSHA`, `SCRIPT LOAD`, `SCRIPT EXISTS`, `SCRIPT FLUSH` | Lua 5.1 with Redis's libraries (see "Lua scripting" below). |
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
