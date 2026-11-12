import { pgError } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import type { DatabaseState, FunctionData } from "../storage/database-state.ts";
import { castTo } from "../types/cast.ts";
import type { TypedValue, TypeId } from "../types/value.ts";
import { tv } from "../types/value.ts";

/** Marks functions installed by `CREATE EXTENSION pgcrypto` (survives PGMM). */
const PGCRYPTO_BODY = "pgcrypto";

const utf8 = new TextEncoder();

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4,
  11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = new Uint32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8,
  0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
  0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87,
  0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039,
  0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
  0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
  0xeb86d391,
]);

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

const SHA512_K = [
  0x428a2f98d728ae22n,
  0x7137449123ef65cdn,
  0xb5c0fbcfec4d3b2fn,
  0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n,
  0x59f111f1b605d019n,
  0x923f82a4af194f9bn,
  0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n,
  0x12835b0145706fben,
  0x243185be4ee4b28cn,
  0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn,
  0x80deb1fe3b1696b1n,
  0x9bdc06a725c71235n,
  0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n,
  0xefbe4786384f25e3n,
  0x0fc19dc68b8cd5b5n,
  0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n,
  0x4a7484aa6ea6e483n,
  0x5cb0a9dcbd41fbd4n,
  0x76f988da831153b5n,
  0x983e5152ee66dfabn,
  0xa831c66d2db43210n,
  0xb00327c898fb213fn,
  0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n,
  0xd5a79147930aa725n,
  0x06ca6351e003826fn,
  0x142929670a0e6e70n,
  0x27b70a8546d22ffcn,
  0x2e1b21385c26c926n,
  0x4d2c6dfc5ac42aedn,
  0x53380d139d95b3dfn,
  0x650a73548baf63den,
  0x766a0abb3c77b2a8n,
  0x81c2c92e47edaee6n,
  0x92722c851482353bn,
  0xa2bfe8a14cf10364n,
  0xa81a664bbc423001n,
  0xc24b8b70d0f89791n,
  0xc76c51a30654be30n,
  0xd192e819d6ef5218n,
  0xd69906245565a910n,
  0xf40e35855771202an,
  0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n,
  0x1e376c085141ab53n,
  0x2748774cdf8eeb99n,
  0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n,
  0x4ed8aa4ae3418acbn,
  0x5b9cca4f7763e373n,
  0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn,
  0x78a5636f43172f60n,
  0x84c87814a1f0ab72n,
  0x8cc702081a6439ecn,
  0x90befffa23631e28n,
  0xa4506cebde82bde9n,
  0xbef9a3f7b2c67915n,
  0xc67178f2e372532bn,
  0xca273eceea26619cn,
  0xd186b8c721c0c207n,
  0xeada7dd6cde0eb1en,
  0xf57d4f7fee6ed178n,
  0x06f067aa72176fban,
  0x0a637dc5a2c898a6n,
  0x113f9804bef90daen,
  0x1b710b35131c471bn,
  0x28db77f523047d84n,
  0x32caab7b40c72493n,
  0x3c9ebe0a15c9bebcn,
  0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n,
  0x597f299cfc657e2an,
  0x5fcb6fab3ad6faecn,
  0x6c44198c4a475817n,
];

const MASK64 = (1n << 64n) - 1n;

function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function rotr64(x: bigint, n: bigint): bigint {
  return ((x >> n) | (x << (64n - n))) & MASK64;
}

/** Pad to `block` bytes with a 1-bit and a big-endian bit length in the last 8 bytes.
 * SHA-512 uses a 16-byte length field; the high 8 bytes stay zero for these sizes. */
function padBe(data: Uint8Array, block: number, lengthBytes: number): Uint8Array {
  const bitLen = BigInt(data.length) * 8n;
  let len = data.length + 1 + lengthBytes;
  const rem = len % block;
  if (rem !== 0) len += block - rem;
  const out = new Uint8Array(len);
  out.set(data);
  out[data.length] = 0x80;
  const view = new DataView(out.buffer);
  view.setUint32(out.length - 8, Number((bitLen >> 32n) & 0xffffffffn), false);
  view.setUint32(out.length - 4, Number(bitLen & 0xffffffffn), false);
  return out;
}

function padMd5(data: Uint8Array): Uint8Array {
  const bitLen = BigInt(data.length) * 8n;
  let len = data.length + 1 + 8;
  const rem = len % 64;
  if (rem !== 0) len += 64 - rem;
  const out = new Uint8Array(len);
  out.set(data);
  out[data.length] = 0x80;
  const view = new DataView(out.buffer);
  view.setUint32(out.length - 8, Number(bitLen & 0xffffffffn), true);
  view.setUint32(out.length - 4, Number((bitLen >> 32n) & 0xffffffffn), true);
  return out;
}

function md5(data: Uint8Array): Uint8Array {
  const bytes = padMd5(data);
  const view = new DataView(bytes.buffer);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (f + a + MD5_K[i]! + m[g]!) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl32(sum, MD5_S[i]!)) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true);
  ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true);
  ov.setUint32(12, d0, true);
  return out;
}

function sha1(data: Uint8Array): Uint8Array {
  const bytes = padBe(data, 64, 8);
  const view = new DataView(bytes.buffer);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(off + t * 4, false);
    for (let t = 16; t < 80; t++) w[t] = rotl32(w[t - 3]! ^ w[t - 8]! ^ w[t - 14]! ^ w[t - 16]!, 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let t = 0; t < 80; t++) {
      let f: number;
      let k: number;
      if (t < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl32(a, 5) + f + e + k + w[t]!) >>> 0;
      e = d;
      d = c;
      c = rotl32(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, h0, false);
  ov.setUint32(4, h1, false);
  ov.setUint32(8, h2, false);
  ov.setUint32(12, h3, false);
  ov.setUint32(16, h4, false);
  return out;
}

function sha256(data: Uint8Array, sha224: boolean): Uint8Array {
  const bytes = padBe(data, 64, 8);
  const view = new DataView(bytes.buffer);
  let h0 = sha224 ? 0xc1059ed8 : 0x6a09e667;
  let h1 = sha224 ? 0x367cd507 : 0xbb67ae85;
  let h2 = sha224 ? 0x3070dd17 : 0x3c6ef372;
  let h3 = sha224 ? 0xf70e5939 : 0xa54ff53a;
  let h4 = sha224 ? 0xffc00b31 : 0x510e527f;
  let h5 = sha224 ? 0x68581511 : 0x9b05688c;
  let h6 = sha224 ? 0x64f98fa7 : 0x1f83d9ab;
  let h7 = sha224 ? 0xbefa4fa4 : 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(off + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const x15 = w[t - 15]!;
      const x2 = w[t - 2]!;
      const s0 = rotr32(x15, 7) ^ rotr32(x15, 18) ^ (x15 >>> 3);
      const s1 = rotr32(x2, 17) ^ rotr32(x2, 19) ^ (x2 >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let t = 0; t < 64; t++) {
      const s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + SHA256_K[t]! + w[t]!) >>> 0;
      const s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  const words = sha224 ? 7 : 8;
  const out = new Uint8Array(words * 4);
  const ov = new DataView(out.buffer);
  const hs = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < words; i++) ov.setUint32(i * 4, hs[i]!, false);
  return out;
}

function readUint64BE(view: DataView, offset: number): bigint {
  return (BigInt(view.getUint32(offset, false)) << 32n) | BigInt(view.getUint32(offset + 4, false));
}

function sha512(data: Uint8Array, sha384: boolean): Uint8Array {
  const bytes = padBe(data, 128, 16);
  const view = new DataView(bytes.buffer);
  let h0 = sha384 ? 0xcbbb9d5dc1059ed8n : 0x6a09e667f3bcc908n;
  let h1 = sha384 ? 0x629a292a367cd507n : 0xbb67ae8584caa73bn;
  let h2 = sha384 ? 0x9159015a3070dd17n : 0x3c6ef372fe94f82bn;
  let h3 = sha384 ? 0x152fecd8f70e5939n : 0xa54ff53a5f1d36f1n;
  let h4 = sha384 ? 0x67332667ffc00b31n : 0x510e527fade682d1n;
  let h5 = sha384 ? 0x8eb44a8768581511n : 0x9b05688c2b3e6c1fn;
  let h6 = sha384 ? 0xdb0c2e0d64f98fa7n : 0x1f83d9abfb41bd6bn;
  let h7 = sha384 ? 0x47b5481dbefa4fa4n : 0x5be0cd19137e2179n;
  const w = new Array<bigint>(80);
  for (let off = 0; off < bytes.length; off += 128) {
    for (let t = 0; t < 16; t++) w[t] = readUint64BE(view, off + t * 8);
    for (let t = 16; t < 80; t++) {
      const x15 = w[t - 15]!;
      const x2 = w[t - 2]!;
      const s0 = rotr64(x15, 1n) ^ rotr64(x15, 8n) ^ (x15 >> 7n);
      const s1 = rotr64(x2, 19n) ^ rotr64(x2, 61n) ^ (x2 >> 6n);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) & MASK64;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let t = 0; t < 80; t++) {
      const s1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
      const ch = (e & f) ^ (~e & g & MASK64);
      const t1 = (h + s1 + ch + SHA512_K[t]! + w[t]!) & MASK64;
      const s0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) & MASK64;
      h = g;
      g = f;
      f = e;
      e = (d + t1) & MASK64;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) & MASK64;
    }
    h0 = (h0 + a) & MASK64;
    h1 = (h1 + b) & MASK64;
    h2 = (h2 + c) & MASK64;
    h3 = (h3 + d) & MASK64;
    h4 = (h4 + e) & MASK64;
    h5 = (h5 + f) & MASK64;
    h6 = (h6 + g) & MASK64;
    h7 = (h7 + h) & MASK64;
  }
  const words = sha384 ? 6 : 8;
  const out = new Uint8Array(words * 8);
  const ov = new DataView(out.buffer);
  const hs = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < words; i++) {
    const word = hs[i]!;
    ov.setUint32(i * 8, Number((word >> 32n) & 0xffffffffn), false);
    ov.setUint32(i * 8 + 4, Number(word & 0xffffffffn), false);
  }
  return out;
}

/** pgcrypto `digest(data, type)` for the algorithms PostgreSQL documents as standard. */
export function digestBytes(data: Uint8Array, algorithm: string): Uint8Array {
  switch (algorithm.toLowerCase().replaceAll("-", "")) {
    case "md5":
      return md5(data);
    case "sha1":
      return sha1(data);
    case "sha224":
      return sha256(data, true);
    case "sha256":
      return sha256(data, false);
    case "sha384":
      return sha512(data, true);
    case "sha512":
      return sha512(data, false);
    default:
      throw pgError("invalid_parameter_value", `Cannot use "${algorithm}": No such hash algorithm`, "22023");
  }
}

export function pgcryptoInstalled(state: DatabaseState): boolean {
  for (const schema of state.schemas.values()) {
    for (const fns of schema.functions.values()) {
      if (fns.some((fn) => fn.language === "internal" && fn.rawBody === PGCRYPTO_BODY)) return true;
    }
  }
  return false;
}

export function installPgcrypto(state: DatabaseState, schemaName: string): void {
  const schema = state.getSchema(schemaName);
  const existing = (schema.functions.get("digest") ?? []).slice();
  // text overload first so untyped literals prefer digest(text, text), as PostgreSQL does.
  const arg0Types: TypeId[] = ["text", "bytea"];
  for (const arg0 of arg0Types) {
    const fn: FunctionData = {
      name: "digest",
      schema: schema.name,
      argNames: [null, null],
      argTypes: [arg0, "text"],
      argDefaults: [null, null],
      returns: "bytea",
      returnsSet: false,
      returnsTable: null,
      language: "internal",
      body: null,
      rawBody: PGCRYPTO_BODY,
      strict: true,
      oid: state.nextOid(),
    };
    existing.push(fn);
  }
  schema.functions.set("digest", existing);
}

export function uninstallPgcrypto(state: DatabaseState): boolean {
  let removed = false;
  for (const schema of state.schemas.values()) {
    for (const [name, fns] of [...schema.functions.entries()]) {
      const keep = fns.filter((fn) => fn.language !== "internal" || fn.rawBody !== PGCRYPTO_BODY);
      if (keep.length === fns.length) continue;
      removed = true;
      if (keep.length === 0) schema.functions.delete(name);
      else schema.functions.set(name, keep);
    }
  }
  return removed;
}

export function evalPgcryptoFunction(ctx: EngineCtx, fn: FunctionData, args: TypedValue[]): TypedValue {
  const ret = fn.returns ?? "bytea";
  if (fn.strict && args.some((arg) => arg.v === null)) return tv(ret, null);
  if (fn.name !== "digest" || args.length !== 2) {
    throw pgError("undefined_function", `function ${fn.schema}.${fn.name} is not implemented`, "42883");
  }
  const data = castTo(ctx, args[0]!, fn.argTypes[0] ?? "bytea", {});
  const algorithm = castTo(ctx, args[1]!, "text", {});
  if (data.v === null || algorithm.v === null) return tv("bytea", null);
  const bytes = fn.argTypes[0] === "bytea" ? (data.v as Uint8Array) : utf8.encode(data.v as string);
  return tv("bytea", digestBytes(bytes, algorithm.v as string));
}
