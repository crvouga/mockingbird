import { connect, type Socket } from "node:net";

/**
 * A byte-level protocol-3.0 client for tests that need exact wire bytes: the extended-query
 * messages with explicit parameter and result format codes, and every backend message back.
 */

export type BackendMessage = { type: string; body: Uint8Array };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
export const fromHex = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "hex"));

const frame = (type: string | null, body: number[]): Buffer => {
  const length = Buffer.alloc(4);
  length.writeInt32BE(body.length + 4);
  return Buffer.concat([type === null ? Buffer.alloc(0) : Buffer.from(type), length, Buffer.from(body)]);
};

const i16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const i32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const cstring = (s: string): number[] => [...encoder.encode(s), 0];

export type BindArgs = {
  portal?: string;
  statement?: string;
  /** Format code per parameter (one code applies to all). */
  paramFormats?: number[];
  /** Parameter values: `null`, text, or raw bytes. */
  params?: (string | Uint8Array | null)[];
  resultFormats?: number[];
};

export class RawClient {
  private buffer = Buffer.alloc(0);
  private waiting: (() => void) | null = null;
  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.waiting?.();
    });
  }

  static async open(
    port: number,
    options: { host?: string; user?: string; database?: string } = {},
  ): Promise<RawClient> {
    const socket = connect({ host: options.host ?? "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const client = new RawClient(socket);
    const params = [...cstring("user"), ...cstring(options.user ?? "postgres")];
    params.push(...cstring("database"), ...cstring(options.database ?? "postgres"), 0);
    socket.write(frame(null, [...i32(196608), ...params]));
    const startup = await client.untilReady();
    const failure = startup.find((m) => m.type === "E");
    if (failure) throw new Error(`startup failed: ${decoder.decode(failure.body)}`);
    return client;
  }

  private async next(): Promise<BackendMessage> {
    for (;;) {
      if (this.buffer.length >= 5) {
        const length = this.buffer.readInt32BE(1);
        if (this.buffer.length >= length + 1) {
          const type = String.fromCharCode(this.buffer[0] as number);
          const body = new Uint8Array(this.buffer.subarray(5, length + 1));
          this.buffer = this.buffer.subarray(length + 1);
          return { type, body };
        }
      }
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }

  async untilReady(): Promise<BackendMessage[]> {
    const messages: BackendMessage[] = [];
    for (;;) {
      const message = await this.next();
      messages.push(message);
      if (message.type === "Z") return messages;
    }
  }

  parse(statement: string, sql: string, oids: number[] = []): void {
    this.socket.write(frame("P", [...cstring(statement), ...cstring(sql), ...i16(oids.length), ...oids.flatMap(i32)]));
  }

  describe(kind: "S" | "P", name = ""): void {
    this.socket.write(frame("D", [kind.charCodeAt(0), ...cstring(name)]));
  }

  closeStatement(name: string): void {
    this.socket.write(frame("C", [83, ...cstring(name)]));
  }

  bind(args: BindArgs = {}): void {
    const formats = args.paramFormats ?? [];
    const params = args.params ?? [];
    const body = [...cstring(args.portal ?? ""), ...cstring(args.statement ?? ""), ...i16(formats.length)];
    for (const format of formats) body.push(...i16(format));
    body.push(...i16(params.length));
    for (const param of params) {
      if (param === null) body.push(...i32(-1));
      else {
        const bytes = typeof param === "string" ? encoder.encode(param) : param;
        body.push(...i32(bytes.length), ...bytes);
      }
    }
    const results = args.resultFormats ?? [];
    body.push(...i16(results.length));
    for (const format of results) body.push(...i16(format));
    this.socket.write(frame("B", body));
  }

  execute(portal = "", maxRows = 0): void {
    this.socket.write(frame("E", [...cstring(portal), ...i32(maxRows)]));
  }

  async sync(): Promise<BackendMessage[]> {
    this.socket.write(frame("S", []));
    return this.untilReady();
  }

  async simple(sql: string): Promise<BackendMessage[]> {
    this.socket.write(frame("Q", cstring(sql)));
    return this.untilReady();
  }

  close(): void {
    this.socket.destroy();
  }
}

/** The ErrorResponse fields of a message as `{ C: code, M: message, ... }`. */
export const errorFields = (message: BackendMessage): Record<string, string> => {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < message.body.length && message.body[i] !== 0) {
    const key = String.fromCharCode(message.body[i] as number);
    let end = i + 1;
    while (message.body[end] !== 0) end++;
    fields[key] = decoder.decode(message.body.subarray(i + 1, end));
    i = end + 1;
  }
  return fields;
};

/** `ParameterDescription` parameter type OIDs. */
export const parameterOids = (message: BackendMessage): number[] => {
  const view = new DataView(message.body.buffer, message.body.byteOffset, message.body.byteLength);
  return Array.from({ length: view.getInt16(0) }, (_, i) => view.getUint32(2 + i * 4));
};

/** `RowDescription` as `{ name, oid, format }` per column. */
export const rowDescription = (message: BackendMessage): { name: string; oid: number; format: number }[] => {
  const view = new DataView(message.body.buffer, message.body.byteOffset, message.body.byteLength);
  const count = view.getInt16(0);
  const columns: { name: string; oid: number; format: number }[] = [];
  let at = 2;
  for (let i = 0; i < count; i++) {
    let end = at;
    while (message.body[end] !== 0) end++;
    const name = decoder.decode(message.body.subarray(at, end));
    at = end + 1;
    const oid = view.getUint32(at + 6);
    const format = view.getInt16(at + 16);
    at += 18;
    columns.push({ name, oid, format });
  }
  return columns;
};

/** `DataRow` cells: bytes, or null for SQL NULL. */
export const dataRow = (message: BackendMessage): (Uint8Array | null)[] => {
  const view = new DataView(message.body.buffer, message.body.byteOffset, message.body.byteLength);
  const count = view.getInt16(0);
  const cells: (Uint8Array | null)[] = [];
  let at = 2;
  for (let i = 0; i < count; i++) {
    const length = view.getInt32(at);
    at += 4;
    if (length === -1) cells.push(null);
    else {
      cells.push(message.body.slice(at, at + length));
      at += length;
    }
  }
  return cells;
};
