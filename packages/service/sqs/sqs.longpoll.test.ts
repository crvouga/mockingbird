import { describe, expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import { createServer } from "./src/server.js"

type Answer = {
  status: number
  body: { Messages?: { Body: string; Attributes?: Record<string, string> }[]; __type?: string }
}

const post = async (
  url: string,
  target: string,
  body: unknown,
  init: { signal?: AbortSignal } = {},
): Promise<Answer> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": `AmazonSQS.${target}`,
    },
    body: JSON.stringify(body),
    ...init,
  })
  return { status: response.status, body: (await response.json()) as Answer["body"] }
}
const real = (ms: number) =>
  new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms))
/** Whether `answer` is still held after a short real pause. */
const isHeld = async (answer: Promise<unknown>) =>
  (await Promise.race([answer, real(80)])) === "pending"

const boot = async (options: Parameters<typeof createServer>[0] = {}) => {
  const clock = createClock(() => Date.now())
  clock.freeze()
  const server = await createServer({ clock, ...options })
  const created = await post(server.url, "CreateQueue", { QueueName: "jobs" })
  return { clock, server, QueueUrl: (created.body as { QueueUrl?: string }).QueueUrl as string }
}
const receive = (url: string, QueueUrl: string, input: Record<string, unknown> = {}) =>
  post(url, "ReceiveMessage", { QueueUrl, AttributeNames: ["All"], ...input })

describe("ReceiveMessage long polling on the emulator clock", () => {
  test("an empty queue holds the request for WaitTimeSeconds of emulator time, then answers empty", async () => {
    const { clock, server, QueueUrl } = await boot()
    try {
      const held = receive(server.url, QueueUrl, { WaitTimeSeconds: 3 })
      expect(await isHeld(held)).toBe(true)
      clock.advance(2_999)
      expect(await isHeld(held)).toBe(true)
      clock.advance(1)
      const answer = await held
      expect(answer.status).toBe(200)
      expect(answer.body.Messages).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  test("a message sent during the wait releases the held request at once", async () => {
    const { server, QueueUrl } = await boot()
    try {
      const held = receive(server.url, QueueUrl, { WaitTimeSeconds: 20 })
      expect(await isHeld(held)).toBe(true)
      await post(server.url, "SendMessage", { QueueUrl, MessageBody: "late" })
      const answer = await held
      expect(answer.body.Messages?.map((message) => message.Body)).toEqual(["late"])
      expect(answer.body.Messages?.[0]?.Attributes?.ApproximateReceiveCount).toBe("1")
    } finally {
      await server.close()
    }
  })

  test("an admin fixture enqueued during the wait releases it too", async () => {
    const { server, QueueUrl } = await boot()
    try {
      const held = receive(server.url, QueueUrl, { WaitTimeSeconds: 20 })
      expect(await isHeld(held)).toBe(true)
      const admin = await fetch(`${server.url}/__admin/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queue: "jobs", body: "fixture" }),
      })
      expect(admin.status).toBe(201)
      expect((await held).body.Messages?.[0]?.Body).toBe("fixture")
    } finally {
      await server.close()
    }
  })

  test("a message that becomes visible during the wait (delay, visibility) releases it on the clock", async () => {
    const { clock, server, QueueUrl } = await boot()
    try {
      await post(server.url, "SendMessage", { QueueUrl, MessageBody: "later", DelaySeconds: 5 })
      const held = receive(server.url, QueueUrl, { WaitTimeSeconds: 20 })
      expect(await isHeld(held)).toBe(true)
      clock.advance(5_000)
      expect((await held).body.Messages?.[0]?.Body).toBe("later")
    } finally {
      await server.close()
    }
  })

  test("the queue's ReceiveMessageWaitTimeSeconds applies unless the call sends WaitTimeSeconds", async () => {
    const { clock, server } = await boot()
    try {
      const configured = await post(server.url, "CreateQueue", {
        QueueName: "slow",
        Attributes: { ReceiveMessageWaitTimeSeconds: "5" },
      })
      const QueueUrl = (configured.body as { QueueUrl?: string }).QueueUrl as string
      const held = receive(server.url, QueueUrl)
      expect(await isHeld(held)).toBe(true)
      const instant = await receive(server.url, QueueUrl, { WaitTimeSeconds: 0 })
      expect(instant.body.Messages).toBeUndefined()
      clock.advance(5_000)
      expect((await held).body.Messages).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  test("a visible message returns at once whatever WaitTimeSeconds says", async () => {
    const { server, QueueUrl } = await boot()
    try {
      await post(server.url, "SendMessage", { QueueUrl, MessageBody: "now" })
      const answer = await receive(server.url, QueueUrl, { WaitTimeSeconds: 20 })
      expect(answer.body.Messages?.[0]?.Body).toBe("now")
    } finally {
      await server.close()
    }
  })

  test("virtual time spends the wait on the clock and answers without sleeping", async () => {
    const { server, QueueUrl } = await boot()
    try {
      server.runtime.configure({ virtualTime: true })
      // Virtual time moves the namespace's own clock, never the shared one.
      const namespaceClock = server.runtime.namespaceClock()
      const before = namespaceClock.now()
      const started = performance.now()
      const answer = await receive(server.url, QueueUrl, { WaitTimeSeconds: 20 })
      expect(answer.body.Messages).toBeUndefined()
      expect(namespaceClock.now() - before).toBe(20_000)
      expect(performance.now() - started).toBeLessThan(1_000)
    } finally {
      await server.close()
    }
  })

  test("a live clock waits in real time", async () => {
    const server = await createServer()
    try {
      const created = await post(server.url, "CreateQueue", { QueueName: "jobs" })
      const QueueUrl = (created.body as { QueueUrl?: string }).QueueUrl as string
      const started = performance.now()
      const answer = await receive(server.url, QueueUrl, { WaitTimeSeconds: 1 })
      expect(answer.body.Messages).toBeUndefined()
      expect(performance.now() - started).toBeGreaterThanOrEqual(950)
    } finally {
      await server.close()
    }
  })

  test("longPoll: false keeps the instant answer", async () => {
    const { server, QueueUrl } = await boot({ longPoll: false })
    try {
      const started = performance.now()
      const answer = await receive(server.url, QueueUrl, { WaitTimeSeconds: 20 })
      expect(answer.status).toBe(200)
      expect(answer.body.Messages).toBeUndefined()
      expect(performance.now() - started).toBeLessThan(1_000)
    } finally {
      await server.close()
    }
  })

  test("WaitTimeSeconds above 20 is InvalidParameterValue", async () => {
    const { server, QueueUrl } = await boot()
    try {
      const answer = await receive(server.url, QueueUrl, { WaitTimeSeconds: 21 })
      expect(answer.status).toBe(400)
      expect(answer.body.__type).toBe("InvalidParameterValue")
    } finally {
      await server.close()
    }
  })

  test("a client that disconnects while held leaves no receive pending", async () => {
    const { server, QueueUrl } = await boot()
    try {
      const controller = new AbortController()
      const held = receive(server.url, QueueUrl, { WaitTimeSeconds: 20 }).catch(() => undefined)
      const abortable = post(
        server.url,
        "ReceiveMessage",
        { QueueUrl, WaitTimeSeconds: 20 },
        { signal: controller.signal },
      ).catch(() => "aborted")
      await real(80)
      controller.abort()
      expect(await abortable).toBe("aborted")
      // The other held request is still a live waiter; release it with a message, then check
      // the aborted one did not take a second copy or hide anything.
      await post(server.url, "SendMessage", { QueueUrl, MessageBody: "one" })
      expect(((await held) as Answer).body.Messages).toHaveLength(1)
      await post(server.url, "SendMessage", { QueueUrl, MessageBody: "two" })
      const next = await receive(server.url, QueueUrl)
      expect(next.body.Messages?.map((message) => message.Body)).toEqual(["two"])
      expect(next.body.Messages?.[0]?.Attributes?.ApproximateReceiveCount).toBe("1")
    } finally {
      await server.close()
    }
  })

  test("a queue deleted during the wait answers NonExistentQueue", async () => {
    const { server, QueueUrl } = await boot()
    try {
      const held = receive(server.url, QueueUrl, { WaitTimeSeconds: 20 })
      expect(await isHeld(held)).toBe(true)
      await post(server.url, "DeleteQueue", { QueueUrl })
      const answer = await held
      expect(answer.status).toBe(400)
      expect(answer.body.__type).toContain("NonExistentQueue")
    } finally {
      await server.close()
    }
  })
})
