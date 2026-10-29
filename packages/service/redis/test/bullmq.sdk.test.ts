import { expect, test } from "bun:test"
import { startFleet } from "@crvouga/mockingbird-adapter-node"
import {
  type ConnectionOptions,
  DelayedError,
  FlowProducer,
  Queue,
  QueueEvents,
  UnrecoverableError,
  Worker,
} from "bullmq"
import { Redis as IORedis } from "ioredis"
import { Redis as LegacyRedis } from "ioredis-5-9"
import { createRedis } from "../src/index.ts"
import { serve, serveTarget } from "../src/server.ts"
import { admissionScript, bullmqContract } from "./bullmq-contract.ts"

test("fleet snapshots reject a running BullMQ job and succeed after completion", async () => {
  const fleet = await startFleet(
    { services: { redis: { protocol: "redis", port: 0 } } },
    { load: async () => serveTarget },
  )
  const endpoint = new URL(fleet.manifest.services.redis?.url as string)
  const connection = {
    host: endpoint.hostname,
    port: Number(endpoint.port),
    maxRetriesPerRequest: null,
  }
  const queue = new Queue("active-fixture", { connection })
  const worker = new Worker(queue.name, undefined, { connection, autorun: false })
  const snapshot = () =>
    fetch(`${fleet.manifest.adminBase}/namespaces/default/snapshots`, { method: "POST" })
  try {
    await queue.add("active", {})
    const job = await worker.getNextJob("owner", { block: false })
    const response = await snapshot()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ services: { redis: { activeJobs: 1 } } })
    await job.moveToCompleted("ok", "owner", false)
    await worker.close(true)
    await queue.close()
    expect((await snapshot()).status).toBe(201)
  } finally {
    await worker.close(true)
    await queue.close()
    await fleet.close()
  }
})

test("BullMQ 5.76 Queue, Worker and QueueEvents complete a job and close", async () => {
  const redis = createRedis()
  const server = await serve(redis, { port: 0 })
  const connection = { host: server.host, port: server.port, maxRetriesPerRequest: null }
  const queue = new Queue("compat", { connection })
  const events = new QueueEvents("compat", { connection })
  const worker = new Worker("compat", async (job) => ({ value: job.data.value + 1 }), {
    connection,
  })
  const errors: Error[] = []
  const onError = (error: Error) => errors.push(error)
  queue.on("error", onError)
  events.on("error", onError)
  worker.on("error", onError)
  try {
    await events.waitUntilReady()
    const job = await queue.add("increment", { value: 7 })
    expect(await job.waitUntilFinished(events, 2000)).toEqual({ value: 8 })
    expect(await job.getState()).toBe("completed")
    expect(errors).toEqual([])
  } finally {
    await worker.close(true)
    await events.close()
    await queue.close()
    await server.close()
  }
  expect(redis.waiterCount()).toBe(0)
}, 5000)

async function manual(
  run: (
    queue: Queue,
    worker: Worker,
    redis: ReturnType<typeof createRedis>,
    connection: { host: string; port: number; maxRetriesPerRequest: null },
  ) => Promise<void>,
) {
  const redis = createRedis()
  const server = await serve(redis, { port: 0 })
  const connection = { host: server.host, port: server.port, maxRetriesPerRequest: null }
  const queue = new Queue("manual", { connection })
  const worker = new Worker("manual", undefined, { connection, autorun: false })
  try {
    await run(queue, worker, redis, connection)
  } finally {
    await worker.close(true)
    await queue.close()
    await server.close()
  }
}

test("BullMQ public-client contract used by the native oracle", async () => {
  const server = await serve(createRedis(), { port: 0 })
  try {
    expect(
      await bullmqContract({ host: server.host, port: server.port, maxRetriesPerRequest: null }),
    ).toMatchObject({
      admission: {
        codes: [1, 0, 0],
        secondAdmission: 1,
        rejectedAdmission: -1,
        windowSize: 2,
        rejectedReceipt: null,
        receiptHasTtl: true,
      },
      paused: true,
      completed: { value: 7 },
      duplicateName: "paused",
      deduplicated: true,
      delayedState: "delayed",
      backoffState: "delayed",
      attemptsMade: 1,
      fatalState: "failed",
      fatalAttempts: 1,
      removed: true,
      parentBefore: "waiting-children",
      childValues: ["child result"],
      reloadState: "completed",
      errors: [],
    })
  } finally {
    await server.close()
  }
})

test("BullMQ accepts an unmodified ioredis 5.9.2 connection", async () => {
  await manual(async (_queue, _worker, _redis, connection) => {
    const legacy = new LegacyRedis(connection)
    // BullMQ's current types include commands absent from ioredis 5.9.2. This test
    // deliberately passes the older, unmodified client to verify runtime compatibility.
    const legacyConnection = legacy as unknown as ConnectionOptions
    const queue = new Queue("legacy", { connection: legacyConnection })
    const worker = new Worker("legacy", undefined, {
      connection: legacyConnection,
      autorun: false,
    })
    try {
      const added = await queue.add("legacy", {})
      const job = await worker.getNextJob("owner", { block: false })
      expect(job.id).toBe(added.id)
      await job.moveToCompleted("ok", "owner", false)
      expect(await added.getState()).toBe("completed")
    } finally {
      await worker.close(true)
      await queue.close()
      await legacy.quit()
    }
  })
})

test("BullMQ observes READONLY and OOM faults, then recovers after they clear", async () => {
  await manual(async (queue, _worker, redis) => {
    redis.fault("readonly")
    await expect(queue.add("readonly", {})).rejects.toThrow("READONLY")
    redis.fault("oom")
    await expect(queue.add("oom", {})).rejects.toThrow("OOM")
    redis.fault(null)
    expect((await queue.add("recovered", {})).id).toBeDefined()
  })
})

test("BullMQ delayed jobs, backoff and attempts follow an injected client/server clock", async () => {
  await manual(async (queue, worker, redis) => {
    const original = Date.now
    let time = original()
    Date.now = () => time
    redis.clock.freeze()
    redis.clock.set(time)
    try {
      const late = await queue.add("late", {}, { delay: 2000 })
      const early = await queue.add(
        "early",
        {},
        { delay: 1000, attempts: 3, backoff: { type: "fixed", delay: 500 } },
      )
      expect(await worker.getNextJob("owner", { block: false })).toBeUndefined()
      time += 1000
      redis.advance(1000)
      const first = await worker.getNextJob("owner", { block: false })
      expect(first?.id).toBe(early.id)
      await first?.moveToFailed(new Error("retry fixture"), "owner", false)
      expect(await early.getState()).toBe("delayed")
      time += 500
      redis.advance(500)
      const retry = await worker.getNextJob("retry-owner", { block: false })
      expect(retry?.attemptsMade).toBe(1)
      await retry?.moveToCompleted("done", "retry-owner", false)
      time += 500
      redis.advance(500)
      const last = await worker.getNextJob("last-owner", { block: false })
      expect(last?.id).toBe(late.id)
      await last?.moveToCompleted("done", "last-owner", false)
    } finally {
      Date.now = original
    }
  })
})

test("BullMQ duplicate IDs, deduplication, auto removal and NOSCRIPT recovery", async () => {
  await manual(async (queue, worker, redis, connection) => {
    const one = await queue.add("one", { value: 1 }, { jobId: "unique", removeOnComplete: true })
    const duplicate = await queue.add("two", { value: 2 }, { jobId: "unique" })
    expect(duplicate.id).toBe(one.id)
    const dedup = await queue.add("dedup", {}, { deduplication: { id: "fixture" } })
    const skipped = await queue.add("dedup", {}, { deduplication: { id: "fixture" } })
    expect(skipped.id).toBe(dedup.id)
    const client = new IORedis(connection)
    try {
      await client.script("FLUSH")
    } finally {
      client.disconnect()
    }
    redis.fault("noscript")
    const job = await worker.getNextJob("owner", { block: false })
    expect(job?.id).toBe("unique")
    await job?.moveToCompleted("ok", "owner", false)
    expect(await queue.getJob("unique")).toBeUndefined()
  })
})

test("BullMQ rate limits release on logical expiry and repeatable schedulers create successors", async () => {
  await manual(async (queue, _worker, redis, connection) => {
    const original = Date.now
    let time = original()
    Date.now = () => time
    redis.clock.freeze()
    redis.clock.set(time)
    const worker = new Worker(queue.name, undefined, {
      connection,
      autorun: false,
      limiter: { max: 1, duration: 1000 },
    })
    try {
      await queue.add("one", {})
      await queue.add("two", {})
      const first = await worker.getNextJob("first", { block: false })
      await first.moveToCompleted("ok", "first", false)
      expect(await worker.getNextJob("limited", { block: false })).toBeUndefined()
      time += 1000
      redis.advance(1000)
      const second = await worker.getNextJob("second", { block: false })
      expect(second.name).toBe("two")
      await second.moveToCompleted("ok", "second", false)
      time += 1000
      redis.advance(1000)
      await queue.upsertJobScheduler("fixture", { every: 1000 }, { name: "scheduled", data: {} })
      const scheduled = await worker.getNextJob("scheduled", { block: false })
      expect(scheduled.name).toBe("scheduled")
      await scheduled.moveToCompleted("ok", "scheduled", false)
      time += 1000
      redis.advance(1000)
      const successor = await worker.getNextJob("successor", { block: false })
      expect(successor.name).toBe("scheduled")
      expect(successor.id).not.toBe(scheduled.id)
      await successor.moveToCompleted("ok", "successor", false)
    } finally {
      Date.now = original
      await worker.close(true)
    }
  })
})

test("delivery admission Lua is atomic under simultaneous public-client callers", async () => {
  await manual(async (_queue, _worker, redis, connection) => {
    redis.clock.freeze()
    redis.clock.set(1_700_000_000_000)
    const clients = [new IORedis(connection), new IORedis(connection), new IORedis(connection)]
    const script = admissionScript
    try {
      expect(
        await Promise.all(
          clients.map((client) =>
            client.eval(
              script,
              2,
              "fixture-window",
              "fixture-receipt",
              redis.clock.now(),
              "fixture",
            ),
          ),
        ),
      ).toEqual([1, 0, 0])
      expect(await clients[0]?.zcard("fixture-window")).toBe(1)
      redis.advance(1000)
      expect(await clients[0]?.get("fixture-receipt")).toBeNull()
      expect(
        await clients[0]?.eval(
          script,
          2,
          "fixture-window",
          "fixture-receipt",
          redis.clock.now(),
          "fixture",
        ),
      ).toBe(1)
    } finally {
      for (const client of clients) client.disconnect()
    }
  })
})

test("BullMQ two workers, lock ownership, renewal, stalled recovery and concurrency", async () => {
  await manual(async (queue, worker, redis, connection) => {
    const other = new Worker("manual", undefined, { connection, autorun: false })
    try {
      await queue.setGlobalConcurrency(1)
      const job = await queue.add("exclusive", {})
      await queue.add("next", {})
      const owner = await worker.getNextJob("owner", { block: false })
      expect(owner?.id).toBe(job.id)
      expect(await other.getNextJob("other", { block: false })).toBeUndefined()
      expect(await owner?.extendLock("owner", 1000)).toBe(1)
      expect(await owner?.extendLock("wrong", 1000)).toBe(0)
      redis.advance(1001)
      const stalled = new Promise<string>((resolve) => worker.once("stalled", resolve))
      worker.opts.stalledInterval = 1
      await worker.startStalledCheckTimer()
      expect(await stalled).toBe(String(job.id))
      expect(await job.getState()).toBe("waiting")
      const recovered = await other.getNextJob("recovered", { block: false })
      expect(recovered?.id).toBe(job.id)
      await recovered?.moveToCompleted("ok", "recovered", false)
    } finally {
      await other.close(true)
    }
  })
})

test("BullMQ flow dependencies release a parent after its child completes", async () => {
  await manual(async (queue, worker, _redis, connection) => {
    const flow = new FlowProducer({ connection })
    try {
      const result = await flow.add({
        name: "parent",
        queueName: queue.name,
        data: {},
        children: [{ name: "child", queueName: queue.name, data: {} }],
      })
      expect(await result.job.getState()).toBe("waiting-children")
      const child = await worker.getNextJob("child-owner", { block: false })
      expect(child?.name).toBe("child")
      await child?.moveToCompleted("child result", "child-owner", false)
      const parent = await worker.getNextJob("parent-owner", { block: false })
      expect(parent?.id).toBe(result.job.id)
      expect(Object.values((await parent?.getChildrenValues()) ?? {})).toEqual(["child result"])
      await parent?.moveToCompleted("parent result", "parent-owner", false)
    } finally {
      await flow.close()
    }
  })
})

test("BullMQ worker treats retryable, DelayedError and UnrecoverableError separately", async () => {
  const redis = createRedis()
  const server = await serve(redis, { port: 0 })
  const connection = { host: server.host, port: server.port, maxRetriesPerRequest: null }
  const queue = new Queue("errors", { connection })
  const events = new QueueEvents("errors", { connection })
  let delayed = false
  const worker = new Worker(
    "errors",
    async (job, token) => {
      if (job.name === "fatal") throw new UnrecoverableError("fixture fatal")
      if (job.name === "retry" && job.attemptsMade === 0) throw new Error("fixture retry")
      if (job.name === "delayed" && !delayed) {
        delayed = true
        await job.moveToDelayed(Date.now(), token)
        throw new DelayedError()
      }
      return "ok"
    },
    { connection },
  )
  const errors: Error[] = []
  const onError = (error: Error) => errors.push(error)
  queue.on("error", onError)
  events.on("error", onError)
  worker.on("error", onError)
  try {
    await events.waitUntilReady()
    const retry = await queue.add("retry", {}, { attempts: 3 })
    expect(await retry.waitUntilFinished(events, 2000)).toBe("ok")
    expect((await queue.getJob(retry.id as string))?.attemptsMade).toBe(2)
    const moved = await queue.add("delayed", {}, { attempts: 3 })
    expect(await moved.waitUntilFinished(events, 2000)).toBe("ok")
    expect((await queue.getJob(moved.id as string))?.attemptsMade).toBe(1)
    const fatal = await queue.add("fatal", {}, { attempts: 3 })
    await expect(fatal.waitUntilFinished(events, 2000)).rejects.toThrow("fixture fatal")
    expect((await queue.getJob(fatal.id as string))?.attemptsMade).toBe(1)
    expect(errors).toEqual([])
  } finally {
    await worker.close(true)
    await events.close()
    await queue.close()
    await server.close()
  }
}, 10000)
