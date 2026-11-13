/**
 * pgcrypto `crypt()` and `gen_salt()`: the password-hashing schemes of contrib/pgcrypto
 * (px-crypt.c), byte-for-byte — MD5-crypt (`$1$`), bcrypt (`$2a$` / `$2x$`), SHA-crypt
 * (`$5$` / `$6$`), traditional DES (two-character salt) and BSDi extended DES (`_`).
 *
 * Pure TypeScript so the engine stays free of Node built-ins. Salts that gen_salt() makes come
 * from the engine PRNG, so they are deterministic per seed like gen_random_uuid().
 */
import { pgError } from "../errors/error.ts";
import { digestBytes } from "./pgcrypto.ts";

const utf8 = new TextEncoder();
const ITOA64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function invalidSalt(): never {
  throw pgError("invalid_parameter_value", "invalid salt", "22023");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** crypt(password, salt): the algorithm is chosen by the salt's prefix, as px_crypt() does. */
export function pgCrypt(password: string, salt: string): string {
  const pw = utf8.encode(password);
  if (salt.startsWith("$2a$") || salt.startsWith("$2x$")) return bcrypt(pw, salt);
  // px_crypt_list has "$2$" with no implementation
  if (salt.startsWith("$2$")) throw pgError("data_exception", "crypt(3) returned NULL", "39000");
  if (salt.startsWith("$1$")) return md5Crypt(pw, salt);
  if (salt.startsWith("$5$")) return shaCrypt(pw, salt, "sha256");
  if (salt.startsWith("$6$")) return shaCrypt(pw, salt, "sha512");
  return desCrypt(pw, salt);
}

// --- gen_salt ------------------------------------------------------------------

const GEN_SALT: Record<
  string,
  {
    bytes: number;
    defRounds: number;
    minRounds: number;
    maxRounds: number;
    make: (rounds: number, r: Uint8Array) => string | null;
  }
> = {
  des: {
    bytes: 2,
    defRounds: 0,
    minRounds: 0,
    maxRounds: 0,
    make: (rounds, r) => (rounds !== 0 && rounds !== 25 ? null : ITOA64[r[0]! & 0x3f]! + ITOA64[r[1]! & 0x3f]!),
  },
  md5: {
    bytes: 6,
    defRounds: 0,
    minRounds: 0,
    maxRounds: 0,
    make: (rounds, r) => {
      if (rounds !== 0 && rounds !== 1000) return null;
      const a = r[0]! | (r[1]! << 8) | (r[2]! << 16);
      const b = r[3]! | (r[4]! << 8) | (r[5]! << 16);
      return `$1$${to64(a, 4)}${to64(b, 4)}`;
    },
  },
  xdes: {
    bytes: 3,
    defRounds: 29 * 25,
    minRounds: 1,
    maxRounds: 0xffffff,
    // even iteration counts make weak DES keys easier to spot, so they are refused
    make: (rounds, r) =>
      rounds % 2 === 0 ? null : `_${to64(rounds, 4)}${to64(r[0]! | (r[1]! << 8) | (r[2]! << 16), 4)}`,
  },
  bf: {
    bytes: 16,
    defRounds: 6,
    minRounds: 4,
    maxRounds: 31,
    make: (rounds, r) => `$2a$${String(rounds).padStart(2, "0")}$${bfEncode(r, 16)}`,
  },
  sha256crypt: {
    bytes: 16,
    defRounds: 5000,
    minRounds: 1000,
    maxRounds: 999_999_999,
    make: (rounds, r) => `$5$rounds=${rounds}$${[...r].map((b) => ITOA64[b & 0x3f]).join("")}`,
  },
  sha512crypt: {
    bytes: 16,
    defRounds: 5000,
    minRounds: 1000,
    maxRounds: 999_999_999,
    make: (rounds, r) => `$6$rounds=${rounds}$${[...r].map((b) => ITOA64[b & 0x3f]).join("")}`,
  },
};

/** gen_salt(type [, rounds]) with `randomBytes` supplying the salt's entropy. */
export function pgGenSalt(type: string, rounds: number, randomBytes: (n: number) => Uint8Array): string {
  const gen = GEN_SALT[type.toLowerCase()];
  if (!gen) throw pgError("invalid_parameter_value", "gen_salt: Unknown salt algorithm", "22023");
  const badRounds = () => pgError("invalid_parameter_value", "gen_salt: Incorrect number of rounds", "22023");
  let count = rounds;
  if (gen.defRounds !== 0) {
    if (count === 0) count = gen.defRounds;
    if (count < gen.minRounds || count > gen.maxRounds) throw badRounds();
  }
  const salt = gen.make(count, randomBytes(gen.bytes));
  if (salt === null) throw badRounds();
  return salt;
}

function to64(value: number, n: number): string {
  let out = "";
  let v = value;
  for (let i = 0; i < n; i++) {
    out += ITOA64[v & 0x3f];
    v >>>= 6;
  }
  return out;
}

// --- MD5-crypt ($1$, Poul-Henning Kamp) ---------------------------------------------

function md5Crypt(pw: Uint8Array, setting: string): string {
  const md5 = (data: Uint8Array) => digestBytes(data, "md5");
  const magic = utf8.encode("$1$");
  let saltText = setting.slice(3);
  const end = saltText.indexOf("$");
  if (end >= 0) saltText = saltText.slice(0, end);
  saltText = saltText.slice(0, 8);
  const salt = utf8.encode(saltText);
  const alt = md5(concat(pw, salt, pw));
  const parts: Uint8Array[] = [pw, magic, salt];
  for (let pl = pw.length; pl > 0; pl -= 16) parts.push(alt.subarray(0, Math.min(16, pl)));
  for (let i = pw.length; i > 0; i >>= 1) parts.push(i & 1 ? new Uint8Array(1) : pw.subarray(0, 1));
  let final = md5(concat(...parts));
  for (let i = 0; i < 1000; i++) {
    const round: Uint8Array[] = [i & 1 ? pw : final];
    if (i % 3) round.push(salt);
    if (i % 7) round.push(pw);
    round.push(i & 1 ? final : pw);
    final = md5(concat(...round));
  }
  const f = final;
  const group = (a: number, b: number, c: number) => to64((f[a]! << 16) | (f[b]! << 8) | f[c]!, 4);
  return `$1$${saltText}$${group(0, 6, 12)}${group(1, 7, 13)}${group(2, 8, 14)}${group(3, 9, 15)}${group(4, 10, 5)}${to64(f[11]!, 2)}`;
}

// --- SHA-crypt ($5$ / $6$, Ulrich Drepper) -----------------------------------------------

const SHA256_ORDER = [
  [0, 10, 20],
  [21, 1, 11],
  [12, 22, 2],
  [3, 13, 23],
  [24, 4, 14],
  [15, 25, 5],
  [6, 16, 26],
  [27, 7, 17],
  [18, 28, 8],
  [9, 19, 29],
];
const SHA512_ORDER = [
  [0, 21, 42],
  [22, 43, 1],
  [44, 2, 23],
  [3, 24, 45],
  [25, 46, 4],
  [47, 5, 26],
  [6, 27, 48],
  [28, 49, 7],
  [50, 8, 29],
  [9, 30, 51],
  [31, 52, 10],
  [53, 11, 32],
  [12, 33, 54],
  [34, 55, 13],
  [56, 14, 35],
  [15, 36, 57],
  [37, 58, 16],
  [59, 17, 38],
  [18, 39, 60],
  [40, 61, 19],
  [62, 20, 41],
];

function repeatTo(source: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = source[i % source.length]!;
  return out;
}

function shaCrypt(pw: Uint8Array, setting: string, algorithm: "sha256" | "sha512"): string {
  const hash = (data: Uint8Array) => digestBytes(data, algorithm);
  const size = algorithm === "sha256" ? 32 : 64;
  let rest = setting.slice(3);
  let rounds = 5000;
  let customRounds = false;
  if (rest.startsWith("rounds=")) {
    const rm = /^rounds=(\d*)\$/.exec(rest);
    if (!rm) throw pgError("syntax", "could not parse salt options", "42601");
    rounds = Math.min(Math.max(Number(rm[1]), 1000), 999_999_999);
    customRounds = true;
    rest = rest.slice(rm[0].length);
  }
  const end = rest.indexOf("$");
  const saltText = (end >= 0 ? rest.slice(0, end) : rest).slice(0, 16);
  const salt = utf8.encode(saltText);
  const b = hash(concat(pw, salt, pw));
  const aParts: Uint8Array[] = [pw, salt, repeatTo(b, pw.length)];
  for (let n = pw.length; n > 0; n >>= 1) aParts.push(n & 1 ? b : pw);
  const a = hash(concat(...aParts));
  const dp = hash(concat(...Array.from({ length: pw.length }, () => pw)));
  const p = pw.length === 0 ? new Uint8Array(0) : repeatTo(dp, pw.length);
  const ds = hash(concat(...Array.from({ length: 16 + a[0]! }, () => salt)));
  const s = salt.length === 0 ? new Uint8Array(0) : repeatTo(ds, salt.length);
  let c = a;
  for (let i = 0; i < rounds; i++) {
    const parts: Uint8Array[] = [i & 1 ? p : c];
    if (i % 3) parts.push(s);
    if (i % 7) parts.push(p);
    parts.push(i & 1 ? c : p);
    c = hash(concat(...parts));
  }
  let encoded = "";
  for (const [x, y, z] of algorithm === "sha256" ? SHA256_ORDER : SHA512_ORDER) {
    encoded += to64((c[x!]! << 16) | (c[y!]! << 8) | c[z!]!, 4);
  }
  encoded += size === 32 ? to64((c[31]! << 8) | c[30]!, 3) : to64(c[63]!, 2);
  const prefix = algorithm === "sha256" ? "$5$" : "$6$";
  return `${prefix}${customRounds ? `rounds=${rounds}$` : ""}${saltText}$${encoded}`;
}

// --- bcrypt ($2a$ / $2x$, Openwall crypt_blowfish) ------------------------------------------

const BF_ALPHABET = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

let blowfishInit: Uint32Array | null = null;

/** Blowfish's initial P-array and S-boxes: the hexadecimal digits of pi's fraction. */
function blowfishInitialState(): Uint32Array {
  if (blowfishInit) return blowfishInit;
  const words = 18 + 1024;
  const bits = BigInt(words * 32 + 64);
  const one = 1n << bits;
  const atanInv = (x: bigint): bigint => {
    const x2 = x * x;
    let term = one / x;
    let sum = term;
    for (let k = 1n, sign = -1n; term !== 0n; k++, sign = -sign) {
      term /= x2;
      sum += (sign * term) / (2n * k + 1n);
    }
    return sum;
  };
  let frac = 16n * atanInv(5n) - 4n * atanInv(239n) - 3n * one;
  const out = new Uint32Array(words);
  for (let i = 0; i < words; i++) {
    frac <<= 32n;
    out[i] = Number(frac >> bits);
    frac &= one - 1n;
  }
  blowfishInit = out;
  return out;
}

function bfEncode(bytes: Uint8Array, length: number): string {
  let out = "";
  let i = 0;
  while (i < length) {
    let c1 = bytes[i++]!;
    out += BF_ALPHABET[c1 >> 2];
    c1 = (c1 & 0x03) << 4;
    if (i >= length) {
      out += BF_ALPHABET[c1];
      break;
    }
    let c2 = bytes[i++]!;
    c1 |= c2 >> 4;
    out += BF_ALPHABET[c1];
    c1 = (c2 & 0x0f) << 2;
    if (i >= length) {
      out += BF_ALPHABET[c1];
      break;
    }
    c2 = bytes[i++]!;
    c1 |= c2 >> 6;
    out += BF_ALPHABET[c1];
    out += BF_ALPHABET[c2 & 0x3f];
  }
  return out;
}

function bfDecode(text: string, length: number): Uint8Array | null {
  const out = new Uint8Array(length);
  let o = 0;
  let i = 0;
  const next = (): number => {
    const v = BF_ALPHABET.indexOf(text[i++] ?? "");
    return v;
  };
  while (o < length) {
    const c1 = next();
    const c2 = next();
    if (c1 < 0 || c2 < 0) return null;
    out[o++] = (c1 << 2) | ((c2 & 0x30) >> 4);
    if (o >= length) break;
    const c3 = next();
    if (c3 < 0) return null;
    out[o++] = ((c2 & 0x0f) << 4) | ((c3 & 0x3c) >> 2);
    if (o >= length) break;
    const c4 = next();
    if (c4 < 0) return null;
    out[o++] = ((c3 & 0x03) << 6) | c4;
  }
  return out;
}

function bcrypt(pw: Uint8Array, setting: string): string {
  if (setting.length < 7 + 22 || setting[6] !== "$" || !/^\d\d$/.test(setting.slice(4, 6))) invalidSalt();
  const cost = Number(setting.slice(4, 6));
  if (cost < 4 || cost > 31) invalidSalt();
  const saltBytes = bfDecode(setting.slice(7, 29), 16);
  if (!saltBytes) invalidSalt();
  const subtype = setting[2]!;
  const init = blowfishInitialState();
  const P = init.slice(0, 18);
  const S = init.slice(18);
  const salt = new Uint32Array(4);
  for (let i = 0; i < 4; i++) {
    salt[i] =
      ((saltBytes[i * 4]! << 24) |
        (saltBytes[i * 4 + 1]! << 16) |
        (saltBytes[i * 4 + 2]! << 8) |
        saltBytes[i * 4 + 3]!) >>>
      0;
  }

  // BF_set_key: the key (with its NUL terminator) cycled into 18 words; "$2x$" keeps the old
  // sign-extension bug, "$2a$" applies Openwall's countermeasure for keys it would have affected
  const key = concat(pw, new Uint8Array(1));
  const expanded = new Uint32Array(18);
  let diff = 0;
  let sign = 0;
  let ptr = 0;
  for (let i = 0; i < 18; i++) {
    let correct = 0;
    let buggy = 0;
    for (let j = 0; j < 4; j++) {
      const byte = key[ptr]!;
      correct = ((correct << 8) | byte) >>> 0;
      buggy = ((buggy << 8) | (byte >= 0x80 ? byte - 256 : byte)) >>> 0;
      if (j > 0) sign |= buggy & 0x80;
      ptr = ptr + 1 >= key.length ? 0 : ptr + 1;
    }
    diff |= correct ^ buggy;
    expanded[i] = subtype === "x" ? buggy : correct;
    P[i] = (P[i]! ^ expanded[i]!) >>> 0;
  }
  diff |= diff >>> 16;
  diff &= 0xffff;
  diff += 0xffff;
  sign <<= 9;
  sign &= ~diff & (subtype === "a" ? 0x10000 : 0);
  P[0] = (P[0]! ^ sign) >>> 0;

  const block = new Uint32Array(2);
  const encrypt = (): void => {
    let l = block[0]!;
    let r = block[1]!;
    for (let i = 0; i < 16; i += 2) {
      l = (l ^ P[i]!) >>> 0;
      r =
        (r ^
          ((((S[l >>> 24]! + S[256 + ((l >>> 16) & 0xff)]!) ^ S[512 + ((l >>> 8) & 0xff)]!) + S[768 + (l & 0xff)]!) >>>
            0)) >>>
        0;
      r = (r ^ P[i + 1]!) >>> 0;
      l =
        (l ^
          ((((S[r >>> 24]! + S[256 + ((r >>> 16) & 0xff)]!) ^ S[512 + ((r >>> 8) & 0xff)]!) + S[768 + (r & 0xff)]!) >>>
            0)) >>>
        0;
    }
    block[0] = (r ^ P[17]!) >>> 0;
    block[1] = (l ^ P[16]!) >>> 0;
  };
  /** Re-key P and S by encrypting a running block, XORing `mix(i)` in before each encryption. */
  const rekey = (mix: ((i: number) => [number, number]) | null): void => {
    block[0] = 0;
    block[1] = 0;
    let n = 0;
    for (let i = 0; i < 18; i += 2, n++) {
      if (mix) {
        const [a, b] = mix(n);
        block[0] = (block[0]! ^ a) >>> 0;
        block[1] = (block[1]! ^ b) >>> 0;
      }
      encrypt();
      P[i] = block[0]!;
      P[i + 1] = block[1]!;
    }
    for (let i = 0; i < 1024; i += 2, n++) {
      if (mix) {
        const [a, b] = mix(n);
        block[0] = (block[0]! ^ a) >>> 0;
        block[1] = (block[1]! ^ b) >>> 0;
      }
      encrypt();
      S[i] = block[0]!;
      S[i + 1] = block[1]!;
    }
  };
  rekey((n) => (n % 2 === 0 ? [salt[0]!, salt[1]!] : [salt[2]!, salt[3]!]));
  for (let round = 2 ** cost; round > 0; round--) {
    for (let i = 0; i < 18; i++) P[i] = (P[i]! ^ expanded[i]!) >>> 0;
    rekey(null);
    for (let i = 0; i < 16; i++) P[i] = (P[i]! ^ salt[i % 4]!) >>> 0;
    P[16] = (P[16]! ^ salt[0]!) >>> 0;
    P[17] = (P[17]! ^ salt[1]!) >>> 0;
    rekey(null);
  }
  const magic = utf8.encode("OrpheanBeholderScryDoubt");
  const out = new Uint8Array(24);
  for (let i = 0; i < 6; i += 2) {
    const word = (k: number) =>
      ((magic[k * 4]! << 24) | (magic[k * 4 + 1]! << 16) | (magic[k * 4 + 2]! << 8) | magic[k * 4 + 3]!) >>> 0;
    block[0] = word(i);
    block[1] = word(i + 1);
    for (let j = 0; j < 64; j++) encrypt();
    for (const [k, w] of [
      [i, block[0]!],
      [i + 1, block[1]!],
    ] as const) {
      out[k * 4] = w >>> 24;
      out[k * 4 + 1] = (w >>> 16) & 0xff;
      out[k * 4 + 2] = (w >>> 8) & 0xff;
      out[k * 4 + 3] = w & 0xff;
    }
  }
  return `${setting.slice(0, 7)}${bfEncode(saltBytes, 16)}${bfEncode(out, 23)}`;
}

// --- DES crypt (traditional and BSDi extended, FreeSec) ---------------------------------------

const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24,
  16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31,
  23, 15, 7,
];
const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21,
  61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49,
  17, 57, 25,
];
const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22,
  23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];
const PERM = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];
const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55,
  47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];
const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30,
  40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const SBOX = [
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1,
    14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
  ],
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14,
    7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
  ],
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6,
    4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
  ],
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6,
    9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
  ],
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1,
    11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
  ],
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14,
    15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
  ],
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4,
    11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
  ],
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11,
    4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
  ],
];

/** 8 key bytes -> the 16 48-bit round keys, as bit arrays. */
function desKeySchedule(key: Uint8Array): number[][] {
  const bits = (i: number) => (key[(i - 1) >> 3]! >> (7 - ((i - 1) & 7))) & 1;
  let c = PC1.slice(0, 28).map(bits);
  let d = PC1.slice(28).map(bits);
  const keys: number[][] = [];
  for (const shift of SHIFTS) {
    c = [...c.slice(shift), ...c.slice(0, shift)];
    d = [...d.slice(shift), ...d.slice(0, shift)];
    const cd = [...c, ...d];
    keys.push(PC2.map((i) => cd[i - 1]!));
  }
  return keys;
}

/** DES-encrypt a 64-bit block `count` times; salt bit i swaps E-box outputs i and i + 24. */
function desEncrypt(block: number[], keys: number[][], saltBits: number, count: number): number[] {
  let state = block;
  for (let iter = 0; iter < count; iter++) {
    const permuted = IP.map((i) => state[i - 1]!);
    let l = permuted.slice(0, 32);
    let r = permuted.slice(32);
    for (let round = 0; round < 16; round++) {
      const e = E.map((i) => r[i - 1]!);
      for (let i = 0; i < 24; i++) {
        if (saltBits & (1 << i)) {
          const t = e[i]!;
          e[i] = e[i + 24]!;
          e[i + 24] = t;
        }
      }
      const k = keys[round]!;
      const sOut: number[] = [];
      for (let s = 0; s < 8; s++) {
        const b = e.slice(s * 6, s * 6 + 6).map((bit, j) => bit ^ k[s * 6 + j]!);
        const row = (b[0]! << 1) | b[5]!;
        const col = (b[1]! << 3) | (b[2]! << 2) | (b[3]! << 1) | b[4]!;
        const v = SBOX[s]![row * 16 + col]!;
        sOut.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1);
      }
      const f = PERM.map((i) => sOut[i - 1]!);
      const next = l.map((bit, i) => bit ^ f[i]!);
      l = r;
      r = next;
    }
    const preOutput = [...r, ...l];
    state = FP.map((i) => preOutput[i - 1]!);
  }
  return state;
}

function asciiToBin(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c > 0x7a) return 0;
  if (c >= 0x61) return c - 0x61 + 38;
  if (c > 0x5a) return 0;
  if (c >= 0x41) return c - 0x41 + 12;
  if (c > 0x39) return 0;
  if (c >= 0x2e) return c - 0x2e;
  return 0;
}

function bytesToBits(bytes: Uint8Array): number[] {
  const bits: number[] = [];
  for (const byte of bytes) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  return bits;
}

function bitsToBytes(bits: number[]): Uint8Array {
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i++) out[i >> 3]! |= bits[i]! << (7 - (i & 7));
  return out;
}

function desCrypt(pw: Uint8Array, setting: string): string {
  const keybuf = new Uint8Array(8);
  let k = 0;
  for (let i = 0; i < 8; i++) {
    keybuf[i] = (pw[k] ?? 0) << 1;
    if (k < pw.length) k++;
  }
  let keys = desKeySchedule(keybuf);
  let count: number;
  let salt: number;
  let prefix: string;
  if (setting.startsWith("_")) {
    // BSDi extended DES: _CCCCSSSS, 24-bit count and 24-bit salt
    if (setting.length < 9) invalidSalt();
    count = 0;
    salt = 0;
    for (let i = 1; i < 5; i++) {
      const v = asciiToBin(setting[i]!);
      if (ITOA64[v] !== setting[i]) invalidSalt();
      count |= v << ((i - 1) * 6);
    }
    if (count === 0) invalidSalt();
    for (let i = 5; i < 9; i++) {
      const v = asciiToBin(setting[i]!);
      if (ITOA64[v] !== setting[i]) invalidSalt();
      salt |= v << ((i - 5) * 6);
    }
    // keys longer than 8 characters fold in: encrypt the key with itself and XOR the next 8
    let rest = pw.subarray(k);
    while (rest.length > 0) {
      const enc = bitsToBytes(desEncrypt(bytesToBits(keybuf), keys, 0, 1));
      keybuf.set(enc);
      const take = Math.min(8, rest.length);
      for (let i = 0; i < take; i++) keybuf[i] = (keybuf[i]! ^ (rest[i]! << 1)) & 0xff;
      rest = rest.subarray(take);
      keys = desKeySchedule(keybuf);
    }
    prefix = setting.slice(0, 9);
  } else {
    if (setting.length < 2) invalidSalt();
    count = 25;
    salt = (asciiToBin(setting[1]!) << 6) | asciiToBin(setting[0]!);
    prefix = setting.slice(0, 2);
  }
  const out = bitsToBytes(desEncrypt(new Array<number>(64).fill(0), keys, salt, count));
  const r0 = ((out[0]! << 24) | (out[1]! << 16) | (out[2]! << 8) | out[3]!) >>> 0;
  const r1 = ((out[4]! << 24) | (out[5]! << 16) | (out[6]! << 8) | out[7]!) >>> 0;
  const chars = (l: number, n: number) => {
    let s = "";
    for (let i = n - 1; i >= 0; i--) s += ITOA64[(l >>> (i * 6)) & 0x3f];
    return s;
  };
  const l1 = r0 >>> 8;
  const l2 = ((r0 << 16) | ((r1 >>> 16) & 0xffff)) >>> 0;
  const l3 = (r1 << 2) >>> 0;
  return `${prefix}${chars(l1, 4)}${chars(l2, 4)}${chars(l3 & 0x3ffff, 3)}`;
}
