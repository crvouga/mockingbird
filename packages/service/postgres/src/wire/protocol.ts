/**
 * PostgreSQL frontend/backend protocol 3.0 message framing: the byte codec only, no behavior.
 * https://www.postgresql.org/docs/18/protocol-message-formats.html
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

export const SSL_REQUEST_CODE = 80877103;
export const GSSENC_REQUEST_CODE = 80877104;
export const CANCEL_REQUEST_CODE = 80877102;
export const PROTOCOL_3_0 = 196608;

/** Growable big-endian byte builder for one or more backend messages. */
export class ByteWriter {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  private len = 0;

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(value: number): this {
    this.ensure(1);
    this.buf[this.len++] = value & 0xff;
    return this;
  }

  i16(value: number): this {
    this.ensure(2);
    this.view.setInt16(this.len, value);
    this.len += 2;
    return this;
  }

  i32(value: number): this {
    this.ensure(4);
    this.view.setInt32(this.len, value);
    this.len += 4;
    return this;
  }

  bytes(value: Uint8Array): this {
    this.ensure(value.byteLength);
    this.buf.set(value, this.len);
    this.len += value.byteLength;
    return this;
  }

  /** A NUL-terminated string. */
  cstring(value: string): this {
    return this.bytes(encoder.encode(value)).u8(0);
  }

  get length(): number {
    return this.len;
  }

  take(): Uint8Array {
    const out = this.buf.slice(0, this.len);
    this.len = 0;
    return out;
  }
}

/** One backend message: type byte, int32 length (including itself), body. */
export const message = (type: string, body: (w: ByteWriter) => void): Uint8Array => {
  const w = new ByteWriter();
  w.u8(type.charCodeAt(0));
  w.i32(0);
  body(w);
  const out = w.take();
  new DataView(out.buffer, out.byteOffset, out.byteLength).setInt32(1, out.byteLength - 1);
  return out;
};

export type FieldDescription = {
  name: string;
  tableOid?: number;
  columnAttr?: number;
  typeOid: number;
  typeLen: number;
  typeMod?: number;
  /** 0 text, 1 binary. */
  format: 0 | 1;
};

export type ErrorFields = {
  severity?: "ERROR" | "FATAL" | "PANIC" | "WARNING" | "NOTICE";
  code: string;
  message: string;
  detail?: string;
  hint?: string;
  position?: number;
  constraint?: string;
  table?: string;
  column?: string;
  schema?: string;
};

const errorBody = (fields: ErrorFields) => (w: ByteWriter) => {
  const severity = fields.severity ?? "ERROR";
  w.u8(0x53).cstring(severity); // S
  w.u8(0x56).cstring(severity); // V
  w.u8(0x43).cstring(fields.code); // C
  w.u8(0x4d).cstring(fields.message); // M
  if (fields.detail !== undefined) w.u8(0x44).cstring(fields.detail); // D
  if (fields.hint !== undefined) w.u8(0x48).cstring(fields.hint); // H
  if (fields.position !== undefined) w.u8(0x50).cstring(String(fields.position)); // P
  if (fields.schema !== undefined) w.u8(0x73).cstring(fields.schema); // s
  if (fields.table !== undefined) w.u8(0x74).cstring(fields.table); // t
  if (fields.column !== undefined) w.u8(0x63).cstring(fields.column); // c
  if (fields.constraint !== undefined) w.u8(0x6e).cstring(fields.constraint); // n
  w.u8(0);
};

export const backend = {
  authenticationOk: () => message("R", (w) => w.i32(0)),
  authenticationSASL: (mechanisms: string[]) =>
    message("R", (w) => {
      w.i32(10);
      for (const m of mechanisms) w.cstring(m);
      w.u8(0);
    }),
  authenticationSASLContinue: (data: string) => message("R", (w) => w.i32(11).bytes(encoder.encode(data))),
  authenticationSASLFinal: (data: string) => message("R", (w) => w.i32(12).bytes(encoder.encode(data))),
  parameterStatus: (name: string, value: string) => message("S", (w) => w.cstring(name).cstring(value)),
  backendKeyData: (pid: number, key: number) => message("K", (w) => w.i32(pid).i32(key)),
  readyForQuery: (status: "I" | "T" | "E") => message("Z", (w) => w.u8(status.charCodeAt(0))),
  rowDescription: (fields: FieldDescription[]) =>
    message("T", (w) => {
      w.i16(fields.length);
      for (const f of fields) {
        w.cstring(f.name)
          .i32(f.tableOid ?? 0)
          .i16(f.columnAttr ?? 0)
          .i32(f.typeOid)
          .i16(f.typeLen)
          .i32(f.typeMod ?? -1)
          .i16(f.format);
      }
    }),
  dataRow: (values: (Uint8Array | null)[]) =>
    message("D", (w) => {
      w.i16(values.length);
      for (const v of values) {
        if (v === null) w.i32(-1);
        else w.i32(v.byteLength).bytes(v);
      }
    }),
  commandComplete: (tag: string) => message("C", (w) => w.cstring(tag)),
  emptyQueryResponse: () => message("I", () => {}),
  errorResponse: (fields: ErrorFields) => message("E", errorBody(fields)),
  noticeResponse: (fields: ErrorFields) => message("N", errorBody({ severity: "NOTICE", ...fields })),
  parseComplete: () => message("1", () => {}),
  bindComplete: () => message("2", () => {}),
  closeComplete: () => message("3", () => {}),
  noData: () => message("n", () => {}),
  portalSuspended: () => message("s", () => {}),
  parameterDescription: (oids: number[]) =>
    message("t", (w) => {
      w.i16(oids.length);
      for (const oid of oids) w.i32(oid);
    }),
  notificationResponse: (pid: number, channel: string, payload: string) =>
    message("A", (w) => w.i32(pid).cstring(channel).cstring(payload)),
  /** The one-byte answers to SSLRequest / GSSENCRequest: no encryption here. */
  no: () => new Uint8Array([0x4e]),
};

/** Sequential reader over one message body. */
export class ByteReader {
  private pos: number;
  private readonly view: DataView;

  constructor(
    readonly bytes: Uint8Array,
    start = 0,
  ) {
    this.pos = start;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.byteLength - this.pos;
  }

  u8(): number {
    if (this.remaining < 1) throw new ProtocolError("message ended early");
    return this.bytes[this.pos++] as number;
  }

  i16(): number {
    if (this.remaining < 2) throw new ProtocolError("message ended early");
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }

  i32(): number {
    if (this.remaining < 4) throw new ProtocolError("message ended early");
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  take(n: number): Uint8Array {
    if (n < 0 || this.remaining < n) throw new ProtocolError("message ended early");
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  cstring(): string {
    const end = this.bytes.indexOf(0, this.pos);
    if (end === -1) throw new ProtocolError("unterminated string");
    const s = decoder.decode(this.bytes.subarray(this.pos, end));
    this.pos = end + 1;
    return s;
  }

  rest(): Uint8Array {
    return this.take(this.remaining);
  }
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export type FrontendMessage =
  | { kind: "ssl" }
  | { kind: "gssenc" }
  | { kind: "cancel"; pid: number; key: number }
  | { kind: "startup"; protocol: number; parameters: Record<string, string> }
  | { kind: "typed"; type: string; body: ByteReader };

/**
 * Splits a byte stream into frontend messages. Before the startup message is seen, frames have
 * no type byte (StartupMessage, SSLRequest, GSSENCRequest, CancelRequest).
 */
export class FrameParser {
  private pending: Uint8Array = new Uint8Array(0);
  private started = false;

  push(chunk: Uint8Array): FrontendMessage[] {
    if (this.pending.byteLength === 0) this.pending = chunk;
    else {
      const next = new Uint8Array(this.pending.byteLength + chunk.byteLength);
      next.set(this.pending);
      next.set(chunk, this.pending.byteLength);
      this.pending = next;
    }
    const out: FrontendMessage[] = [];
    for (;;) {
      const frame = this.next();
      if (!frame) return out;
      out.push(frame);
    }
  }

  private next(): FrontendMessage | undefined {
    const buf = this.pending;
    if (!this.started) {
      if (buf.byteLength < 8) return undefined;
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const length = view.getInt32(0);
      if (length < 8 || length > 10_000) throw new ProtocolError(`invalid startup packet length ${length}`);
      if (buf.byteLength < length) return undefined;
      const code = view.getInt32(4);
      this.pending = buf.subarray(length);
      if (code === SSL_REQUEST_CODE) return { kind: "ssl" };
      if (code === GSSENC_REQUEST_CODE) return { kind: "gssenc" };
      if (code === CANCEL_REQUEST_CODE) {
        return { kind: "cancel", pid: view.getInt32(8), key: view.getInt32(12) };
      }
      const r = new ByteReader(buf.subarray(8, length));
      const parameters: Record<string, string> = {};
      while (r.remaining > 1) {
        const key = r.cstring();
        if (key === "") break;
        parameters[key] = r.cstring();
      }
      this.started = true;
      return { kind: "startup", protocol: code, parameters };
    }
    if (buf.byteLength < 5) return undefined;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const length = view.getInt32(1);
    if (length < 4) throw new ProtocolError(`invalid message length ${length}`);
    if (buf.byteLength < length + 1) return undefined;
    const type = String.fromCharCode(buf[0] as number);
    const body = new ByteReader(buf.subarray(5, length + 1));
    this.pending = buf.subarray(length + 1);
    return { kind: "typed", type, body };
  }
}

export const utf8 = {
  encode: (s: string): Uint8Array => encoder.encode(s),
  decode: (b: Uint8Array): string => decoder.decode(b),
};
