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
| scripts | `EVAL`, `EVALSHA`, `SCRIPT LOAD`, `SCRIPT EXISTS`, `SCRIPT FLUSH` | Lua subset, `cjson` and `cmsgpack.pack`/`unpack`. |
| cluster | `CLUSTER`, `READONLY`, `ASKING` | Single node: cluster support disabled. |

BullMQ 5.67.1 is exercised through unmodified Queue, Worker, QueueEvents and FlowProducer clients:
completion, delays/backoff, retry and unrecoverable errors, explicit delayed transitions,
deduplication/unique IDs, auto removal, rate limits, repeatable schedulers, global concurrency, lock ownership/renewal, stalled recovery,
parent dependencies, and SCRIPT FLUSH/NOSCRIPT reload. Both ioredis 5.9.2 and 5.11.1 are tested.
See `test/bullmq.sdk.test.ts`. `bun run parity:bullmq` runs the identical public-client contract
against the emulator and an installed local `redis-server` (verified with Redis 8.4.0).

Out of scope: Redis Cluster, Redis 8 modules and a complete Lua 5.1 runtime. Compatibility claims
are limited to the tested BullMQ flows rather than every arbitrary Lua program.

## Fleet controls

The fleet adapter supports dynamic namespace listeners, finite numeric seeds, boot/reset clocks,
connection admission quotas, private pre-ready seeding listeners, bounded key/type/TTL inspection,
and portable `mockingbird.redis/v1` archives. Binary values, Maps, bigint stream ids, Lua scripts,
random state, consumer pause state and queued/delayed BullMQ work survive process replacement.
Live blocked/active work must drain before capture. Fleet latency/fault profiles are unsupported for
RESP children and are rejected explicitly. See [Fleets](../../../docs/FLEETS.md) and the adapter's
`fleet.management.test.ts` acceptance suite (real ioredis clients).
