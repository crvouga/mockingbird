/// <reference types="node" />
import { createHash, createPrivateKey, createPublicKey } from "node:crypto"
import type { AddressInfo } from "node:net"
import { posix } from "node:path"
import ssh2, { type AuthContext, type Connection, type FileEntry } from "ssh2"

const { Server, utils } = ssh2
const { OPEN_MODE, STATUS_CODE } = utils.sftp
const seedBytes = createHash("sha256").update("mockingbird-aha-sftp-host-v1").digest()
const hostKeyObject = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seedBytes]),
  format: "der",
  type: "pkcs8",
})
const publicJwk = createPublicKey(hostKeyObject).export({ format: "jwk" })
if (!publicJwk.x) throw new Error("failed to derive AHA SFTP host public key")
const publicBytes = Buffer.from(publicJwk.x, "base64url")
const uint32 = (value: number) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}
const sshString = (value: string | Buffer) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  return Buffer.concat([uint32(bytes.length), bytes])
}
const publicBlock = Buffer.concat([sshString("ssh-ed25519"), sshString(publicBytes)])
let privateBlock = Buffer.concat([
  uint32(0x4d424148),
  uint32(0x4d424148),
  sshString("ssh-ed25519"),
  sshString(publicBytes),
  sshString(Buffer.concat([seedBytes, publicBytes])),
  sshString("mockingbird-aha"),
])
const padding = 8 - (privateBlock.length % 8)
privateBlock = Buffer.concat([
  privateBlock,
  Buffer.from([...Array(padding)].map((_, index) => index + 1)),
])
const encodedHostKey = Buffer.concat([
  Buffer.from("openssh-key-v1\0"),
  sshString("none"),
  sshString("none"),
  sshString(Buffer.alloc(0)),
  uint32(1),
  sshString(publicBlock),
  sshString(privateBlock),
]).toString("base64")
const HOST_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${encodedHostKey.match(/.{1,70}/g)?.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`

export type AhaSftpAccount = {
  username: string
  password?: string
  publicKey?: string
  namespace?: string
}
export type AhaSftpFault =
  | { type: "permission" | "disconnect" | "disk-full" }
  | { type: "partial-write"; afterBytes: number }
export type AhaSftpJournalEntry = {
  at: number
  namespace: string
  account: string
  operation: string
  path?: string
  bytes?: number
  status: "ok" | "error"
}
export type AhaSftpServerOptions = {
  runtime: AhaSftpRuntime
  accounts?: AhaSftpAccount[]
  host?: string
  port?: number
  now?: () => number
}
/** Structural slice of the portable runtime used by the Node-only SFTP adapter. */
export type AhaSftpRuntime = {
  clock: { now(): number }
  instance(namespace?: string): {
    state: {
      findOrder(
        id: string,
      ): { partner_order_id: string; order_number: string; status: string } | undefined
    }
    transition(id: string, input: { status: string }): unknown
  }
}
export type AhaSftpServer = {
  host: string
  port: number
  hostPublicKey: Buffer
  publishResult(
    orderId: string,
    bytes: Uint8Array,
    options?: { namespace?: string; path?: string },
  ): string
  seed(
    path: string,
    bytes: Uint8Array,
    options?: { namespace?: string; account?: string; mode?: number },
  ): void
  list(options?: {
    namespace?: string
    account?: string
  }): { path: string; size: number; mode: number; mtime: number }[]
  fault(next: AhaSftpFault): void
  journal(): readonly AhaSftpJournalEntry[]
  reset(namespace?: string): void
  close(): Promise<void>
}

type FileRecord = {
  bytes: Buffer
  mode: number
  mtime: number
  orderId?: string
  consumed?: boolean
}
type OpenHandle =
  | { kind: "file"; path: string; flags: number }
  | { kind: "directory"; path: string; read: boolean }

const normalize = (value: string) => posix.resolve("/", value)
const attrs = (file: FileRecord) => ({
  mode: 0o100000 | file.mode,
  uid: 1000,
  gid: 1000,
  size: file.bytes.length,
  atime: file.mtime,
  mtime: file.mtime,
})
const directoryAttrs = (time: number) => ({
  mode: 0o040755,
  uid: 1000,
  gid: 1000,
  size: 0,
  atime: time,
  mtime: time,
})

/** Start an actual SSH/SFTP endpoint sharing order state with an AHA HTTP runtime. */
export async function createAhaSftpServer(options: AhaSftpServerOptions): Promise<AhaSftpServer> {
  const now = options.now ?? options.runtime.clock.now
  const accounts = options.accounts ?? [{ username: "aha", password: "mockingbird" }]
  if (accounts.length === 0) throw new Error("at least one SFTP account is required")
  const files = new Map<string, Map<string, FileRecord>>()
  const directories = new Map<string, Set<string>>()
  const journal: AhaSftpJournalEntry[] = []
  let nextFault: AhaSftpFault | undefined
  const tree = (namespace: string, account: string) => {
    const key = `${namespace}\0${account}`
    let records = files.get(key)
    if (!records) {
      records = new Map()
      files.set(key, records)
      directories.set(key, new Set(["/", "/inbox", "/outbox"]))
    }
    return { files: records, directories: directories.get(key) as Set<string> }
  }
  const record = (entry: Omit<AhaSftpJournalEntry, "at">) => {
    journal.push({ at: now(), ...entry })
    if (journal.length > 1000) journal.shift()
  }
  const authenticate = (context: AuthContext) => {
    const account = accounts.find((candidate) => candidate.username === context.username)
    if (context.method === "password" && account?.password === context.password)
      return context.accept()
    if (context.method === "publickey" && account?.publicKey) {
      const parsed = utils.parseKey(account.publicKey)
      const expected = Array.isArray(parsed) ? parsed[0] : parsed
      if (
        expected &&
        !(expected instanceof Error) &&
        expected.type === context.key.algo &&
        expected.getPublicSSH().equals(context.key.data) &&
        (!context.signature || expected.verify(context.blob, context.signature, context.hashAlgo))
      )
        return context.accept()
    }
    return context.reject(["password", "publickey"])
  }
  const attach = (client: Connection, account: AhaSftpAccount) => {
    client.on("session", (accept) => {
      const session = accept()
      session.on("sftp", (acceptSftp) => {
        const sftp = acceptSftp()
        const namespace = account.namespace ?? "default"
        const root = tree(namespace, account.username)
        const handles = new Map<string, OpenHandle>()
        let sequence = 0
        const openHandle = (value: OpenHandle) => {
          const id = Buffer.alloc(4)
          id.writeUInt32BE(++sequence)
          handles.set(id.toString("hex"), value)
          return id
        }
        const status = (id: number, code: number, message?: string) =>
          sftp.status(id, code, message)
        const fault = (id: number, operation: string, path?: string) => {
          const active = nextFault
          if (!active) return false
          nextFault = undefined
          record({
            namespace,
            account: account.username,
            operation,
            ...(path ? { path } : {}),
            status: "error",
          })
          if (active.type === "disconnect") client.end()
          else
            status(
              id,
              active.type === "permission" ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE,
            )
          return true
        }
        sftp.on("REALPATH", (id, path) => {
          const resolved = normalize(path)
          sftp.name(id, [{ filename: resolved, longname: resolved, attrs: directoryAttrs(now()) }])
        })
        sftp.on("STAT", (id, path) => {
          const resolved = normalize(path)
          const file = root.files.get(resolved)
          if (file) sftp.attrs(id, attrs(file))
          else if (root.directories.has(resolved)) sftp.attrs(id, directoryAttrs(now()))
          else status(id, STATUS_CODE.NO_SUCH_FILE)
        })
        sftp.on("OPENDIR", (id, path) => {
          const resolved = normalize(path)
          if (fault(id, "opendir", resolved)) return
          if (!root.directories.has(resolved)) return status(id, STATUS_CODE.NO_SUCH_FILE)
          sftp.handle(id, openHandle({ kind: "directory", path: resolved, read: false }))
        })
        sftp.on("READDIR", (id, raw) => {
          const open = handles.get(raw.toString("hex"))
          if (open?.kind !== "directory") return status(id, STATUS_CODE.FAILURE)
          if (open.read) return status(id, STATUS_CODE.EOF)
          open.read = true
          const entries: FileEntry[] = []
          for (const path of root.directories)
            if (path !== open.path && posix.dirname(path) === open.path)
              entries.push({
                filename: posix.basename(path),
                longname: posix.basename(path),
                attrs: directoryAttrs(now()),
              })
          for (const [path, file] of root.files)
            if (posix.dirname(path) === open.path)
              entries.push({
                filename: posix.basename(path),
                longname: posix.basename(path),
                attrs: attrs(file),
              })
          sftp.name(id, entries)
        })
        sftp.on("OPEN", (id, filename, flags) => {
          const path = normalize(filename)
          if (fault(id, "open", path)) return
          if (!root.directories.has(posix.dirname(path)))
            return status(id, STATUS_CODE.NO_SUCH_FILE)
          const current = root.files.get(path)
          if (!current && !(flags & OPEN_MODE.CREAT)) return status(id, STATUS_CODE.NO_SUCH_FILE)
          if (current && flags & OPEN_MODE.EXCL) return status(id, STATUS_CODE.FAILURE)
          if (!current || flags & OPEN_MODE.TRUNC)
            root.files.set(path, {
              bytes: Buffer.alloc(0),
              mode: 0o640,
              mtime: Math.floor(now() / 1000),
            })
          sftp.handle(id, openHandle({ kind: "file", path, flags }))
        })
        sftp.on("READ", (id, raw, offset, length) => {
          const open = handles.get(raw.toString("hex"))
          if (open?.kind !== "file") return status(id, STATUS_CODE.FAILURE)
          if (fault(id, "read", open.path)) return
          const file = root.files.get(open.path)
          if (!file) return status(id, STATUS_CODE.NO_SUCH_FILE)
          if (offset >= file.bytes.length) return status(id, STATUS_CODE.EOF)
          const data = file.bytes.subarray(offset, Math.min(offset + length, file.bytes.length))
          sftp.data(id, data)
          record({
            namespace,
            account: account.username,
            operation: "read",
            path: open.path,
            bytes: data.length,
            status: "ok",
          })
        })
        sftp.on("WRITE", (id, raw, offset, input) => {
          const open = handles.get(raw.toString("hex"))
          if (open?.kind !== "file") return status(id, STATUS_CODE.FAILURE)
          if (nextFault?.type === "disk-full") return void fault(id, "write", open.path)
          let data = input
          if (nextFault?.type === "partial-write") {
            data = input.subarray(0, nextFault.afterBytes)
            nextFault = undefined
          } else if (fault(id, "write", open.path)) return
          const file = root.files.get(open.path) as FileRecord
          const output = Buffer.alloc(Math.max(file.bytes.length, offset + data.length))
          file.bytes.copy(output)
          data.copy(output, offset)
          file.bytes = output
          file.mtime = Math.floor(now() / 1000)
          status(id, STATUS_CODE.OK)
          record({
            namespace,
            account: account.username,
            operation: "write",
            path: open.path,
            bytes: data.length,
            status: "ok",
          })
        })
        sftp.on("CLOSE", (id, raw) => {
          const open = handles.get(raw.toString("hex"))
          handles.delete(raw.toString("hex"))
          if (open?.kind === "file") {
            const file = root.files.get(open.path)
            if (file?.orderId && !file.consumed && open.flags & OPEN_MODE.READ) {
              file.consumed = true
              options.runtime
                .instance(namespace)
                .transition(file.orderId, { status: "Lab Testing In Progress" })
            }
          }
          status(id, STATUS_CODE.OK)
        })
        sftp.on("RENAME", (id, oldName, newName) => {
          const oldPath = normalize(oldName)
          const newPath = normalize(newName)
          if (fault(id, "rename", oldPath)) return
          const file = root.files.get(oldPath)
          if (!file) return status(id, STATUS_CODE.NO_SUCH_FILE)
          if (root.files.has(newPath) || !root.directories.has(posix.dirname(newPath)))
            return status(id, STATUS_CODE.FAILURE)
          root.files.delete(oldPath)
          root.files.set(newPath, file)
          status(id, STATUS_CODE.OK)
        })
        sftp.on("REMOVE", (id, path) => {
          const resolved = normalize(path)
          if (fault(id, "remove", resolved)) return
          status(id, root.files.delete(resolved) ? STATUS_CODE.OK : STATUS_CODE.NO_SUCH_FILE)
        })
        sftp.on("MKDIR", (id, path) => {
          const resolved = normalize(path)
          if (fault(id, "mkdir", resolved)) return
          if (!root.directories.has(posix.dirname(resolved)))
            return status(id, STATUS_CODE.NO_SUCH_FILE)
          root.directories.add(resolved)
          status(id, STATUS_CODE.OK)
        })
      })
    })
  }
  const server = new Server(
    {
      hostKeys: [HOST_KEY],
      ident: "SSH-2.0-Mockingbird_AHA",
      algorithms: { serverHostKey: ["ssh-ed25519"] },
    },
    (client) => {
      let authenticated: AhaSftpAccount | undefined
      // Authentication and host-key rejection are expected negative-test paths.
      client.on("error", () => undefined)
      client.on("authentication", (context) => {
        authenticated = accounts.find((account) => account.username === context.username)
        authenticate(context)
      })
      client.on("ready", () => authenticated && attach(client, authenticated))
    },
  )
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve)
  })
  const address = server.address() as AddressInfo
  const defaultAccount = accounts[0] as AhaSftpAccount
  const seed = (
    path: string,
    bytes: Uint8Array,
    input: { namespace?: string; account?: string; mode?: number } = {},
  ) => {
    const root = tree(input.namespace ?? "default", input.account ?? defaultAccount.username)
    const resolved = normalize(path)
    if (!root.directories.has(posix.dirname(resolved)))
      throw new Error(`missing SFTP directory ${posix.dirname(resolved)}`)
    root.files.set(resolved, {
      bytes: Buffer.from(bytes),
      mode: input.mode ?? 0o640,
      mtime: Math.floor(now() / 1000),
    })
  }
  const parsedHost = utils.parseKey(HOST_KEY)
  if (parsedHost instanceof Error || Array.isArray(parsedHost))
    throw new Error("failed to create host key")
  return {
    host: address.address,
    port: address.port,
    hostPublicKey: parsedHost.getPublicSSH(),
    publishResult(orderId, bytes, input = {}) {
      const namespace = input.namespace ?? "default"
      const order = options.runtime.instance(namespace).state.findOrder(orderId)
      if (!order) throw new Error(`no order ${orderId}`)
      const path = normalize(input.path ?? `/outbox/${order.order_number}_result.pdf`)
      seed(path, bytes, { namespace })
      const file = tree(namespace, defaultAccount.username).files.get(path) as FileRecord
      file.orderId = order.partner_order_id
      return path
    },
    seed,
    list(input = {}) {
      const root = tree(input.namespace ?? "default", input.account ?? defaultAccount.username)
      return [...root.files]
        .map(([path, file]) => ({
          path,
          size: file.bytes.length,
          mode: file.mode,
          mtime: file.mtime,
        }))
        .sort((left, right) => left.path.localeCompare(right.path))
    },
    fault(next) {
      nextFault = next
    },
    journal: () => journal,
    reset(namespace) {
      for (const key of [...files.keys()])
        if (namespace === undefined || key.startsWith(`${namespace}\0`)) files.delete(key)
      for (const key of [...directories.keys()])
        if (namespace === undefined || key.startsWith(`${namespace}\0`)) directories.delete(key)
      journal.length = 0
      nextFault = undefined
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}
