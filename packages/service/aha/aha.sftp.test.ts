import { describe, expect, test } from "bun:test"
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2"
import { createRuntime } from "./src/runtime.js"
import { type AhaSftpServer, createAhaSftpServer } from "./src/sftp.js"

const connect = (
  server: AhaSftpServer,
  overrides: Partial<ConnectConfig> = {},
): Promise<{ client: Client; sftp: SFTPWrapper }> =>
  new Promise((resolve, reject) => {
    const client = new Client()
    client
      .once("error", reject)
      .once("ready", () =>
        client.sftp((error, sftp) => (error ? reject(error) : resolve({ client, sftp }))),
      )
      .connect({
        host: server.host,
        port: server.port,
        username: "aha",
        password: "mockingbird",
        hostVerifier: (key: Buffer) => key.equals(server.hostPublicKey),
        ...overrides,
      })
  })

const read = (sftp: SFTPWrapper, path: string): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    sftp.readFile(path, (error, bytes) => (error ? reject(error) : resolve(bytes))),
  )
const write = (sftp: SFTPWrapper, path: string, bytes: Buffer): Promise<void> =>
  new Promise((resolve, reject) =>
    sftp.writeFile(path, bytes, (error) => (error ? reject(error) : resolve())),
  )
const rename = (sftp: SFTPWrapper, from: string, to: string): Promise<void> =>
  new Promise((resolve, reject) =>
    sftp.rename(from, to, (error) => (error ? reject(error) : resolve())),
  )
const remove = (sftp: SFTPWrapper, path: string): Promise<void> =>
  new Promise((resolve, reject) =>
    sftp.unlink(path, (error) => (error ? reject(error) : resolve())),
  )

describe("AHA SFTP server", () => {
  test("unmodified ssh2 client preserves bytes and supports atomic file lifecycle", async () => {
    const runtime = createRuntime()
    const server = await createAhaSftpServer({ runtime })
    try {
      const { client, sftp } = await connect(server)
      const binary = Buffer.from([0, 1, 2, 255, 13, 10, 0, 42])
      await write(sftp, "/inbox/result.tmp", binary)
      await rename(sftp, "/inbox/result.tmp", "/inbox/result.pdf")
      expect(await read(sftp, "/inbox/result.pdf")).toEqual(binary)
      expect(server.list()).toEqual([
        expect.objectContaining({ path: "/inbox/result.pdf", size: binary.length, mode: 0o640 }),
      ])
      await remove(sftp, "/inbox/result.pdf")
      expect(server.list()).toEqual([])
      expect(server.journal().every((entry) => !("contents" in entry))).toBe(true)
      client.end()
    } finally {
      await server.close()
      runtime.stop()
    }
  })

  test("published results share order state and consumption transitions exactly once", async () => {
    const runtime = createRuntime()
    const api = runtime.instance()
    api.state.orders.insert("order-1", {
      partner_order_id: "order-1",
      order_number: "AHA-0000000001",
      status: "Check Out",
      drawStatus: "Sample Collected",
      scheduledAt: null,
      timeZone: "America/Phoenix",
      cancelled: false,
      created_at: "2030-01-01T00:00:00.000Z",
      updated_at: "2030-01-01T00:00:00.000Z",
      createdAtMs: 1_893_456_000_000,
      autoScheduled: false,
    })
    const server = await createAhaSftpServer({ runtime })
    try {
      const path = server.publishResult("order-1", Buffer.from("result"))
      const first = await connect(server)
      expect((await read(first.sftp, path)).toString()).toBe("result")
      first.client.end()
      await Bun.sleep(20)
      expect(api.state.findOrder("order-1")?.status).toBe("Lab Testing In Progress")
      const second = await connect(server)
      await read(second.sftp, path)
      second.client.end()
      expect(api.state.findOrder("order-1")?.status).toBe("Lab Testing In Progress")
    } finally {
      await server.close()
      runtime.stop()
    }
  })

  test("auth, host verification, faults and reconnect are recoverable", async () => {
    const runtime = createRuntime()
    const server = await createAhaSftpServer({ runtime })
    try {
      await expect(connect(server, { password: "wrong" })).rejects.toThrow()
      await expect(connect(server, { hostVerifier: () => false })).rejects.toThrow()
      server.seed("/outbox/result.pdf", Buffer.from("complete"))
      const first = await connect(server)
      server.fault({ type: "disconnect" })
      await expect(read(first.sftp, "/outbox/result.pdf")).rejects.toThrow()
      first.client.end()
      const recovered = await connect(server)
      expect((await read(recovered.sftp, "/outbox/result.pdf")).toString()).toBe("complete")
      recovered.client.end()
    } finally {
      await server.close()
      runtime.stop()
    }
  })
})
