import { pgError } from "../errors/error.ts";

/**
 * `inet`, `cidr` and `macaddr` (https://www.postgresql.org/docs/18/datatype-net-types.html).
 * A datum is the canonical output text, which is what equality, grouping and storage use;
 * ordering parses it back (`networkCompare`). Operators on these types (`<<`, `&&`, `+`) are not modelled.
 */

export type NetworkType = "inet" | "cidr";

export interface NetworkValue {
  /** 4 or 16 address bytes */
  readonly bytes: Uint8Array;
  readonly bits: number;
}

const invalidInput = (type: string, text: string): never => {
  throw pgError("invalid_text_representation", `invalid input syntax for type ${type}: "${text}"`, "22P02");
};

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(text: string): Uint8Array | null {
  const m = IPV4_RE.exec(text);
  if (!m) return null;
  const bytes = Uint8Array.of(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));
  return [m[1], m[2], m[3], m[4]].every((octet) => Number(octet) <= 255) ? bytes : null;
}

function parseIpv6(text: string): Uint8Array | null {
  if (!/^[0-9a-fA-F:.]+$/.test(text) || text.includes(":::")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const words = (part: string, last: boolean): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const groups = part.split(":");
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      if (group.includes(".")) {
        if (!last || i !== groups.length - 1) return null;
        // an embedded IPv4 address takes the last two words
        const v4 = parseIpv4(group);
        if (!v4) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(group)) out.push(Number.parseInt(group, 16));
      else return null;
    }
    return out;
  };
  const head = words(halves[0]!, halves.length === 1);
  const tail = halves.length === 2 ? words(halves[1]!, true) : [];
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = [...head, ...new Array<number>(Math.max(fill, 0)).fill(0), ...tail];
  const bytes = new Uint8Array(16);
  all.forEach((word, i) => {
    bytes[i * 2] = word >> 8;
    bytes[i * 2 + 1] = word & 0xff;
  });
  return bytes;
}

/** Bits an IPv4 `cidr` without `/n` gets: the classful default, widened to cover the octets given. */
function classfulBits(first: number, octets: number): number {
  let bits: number;
  if (first >= 240) bits = 32;
  else if (first >= 224) bits = 8;
  else if (first >= 192) bits = 24;
  else if (first >= 128) bits = 16;
  else bits = 8;
  if (bits < octets * 8) bits = octets * 8;
  if (bits === 8 && first === 224) bits = 4;
  return bits;
}

function hostBitsSet(bytes: Uint8Array, bits: number): boolean {
  for (let i = 0; i < bytes.length * 8; i++) {
    if (i >= bits && (bytes[i >> 3]! & (0x80 >> (i & 7))) !== 0) return true;
  }
  return false;
}

export function parseNetwork(type: NetworkType, input: string): NetworkValue {
  const slash = input.indexOf("/");
  const address = slash === -1 ? input : input.slice(0, slash);
  const maskText = slash === -1 ? null : input.slice(slash + 1);
  let bytes: Uint8Array | null = null;
  let given = 4;
  if (address.includes(":")) bytes = parseIpv6(address);
  else if (type === "cidr" && /^\d{1,3}(\.\d{1,3}){0,3}$/.test(address)) {
    // cidr takes abbreviated IPv4 (`10.1`, `192.168.1`)
    const octets = address.split(".").map(Number);
    if (octets.every((o) => o <= 255)) {
      given = octets.length;
      bytes = Uint8Array.from([...octets, 0, 0, 0].slice(0, 4));
    }
  } else bytes = parseIpv4(address);
  if (!bytes) return invalidInput(type, input);
  const max = bytes.length * 8;
  let bits: number;
  if (maskText === null) bits = type === "cidr" && bytes.length === 4 ? classfulBits(bytes[0]!, given) : max;
  else if (/^\d{1,3}$/.test(maskText) && Number(maskText) <= max) bits = Number(maskText);
  else return invalidInput(type, input);
  if (type === "cidr" && hostBitsSet(bytes, bits)) {
    throw pgError("invalid_text_representation", `invalid cidr value: "${input}"`, "22P02");
  }
  return { bytes, bits };
}

function formatIpv6(bytes: Uint8Array): string {
  const words = Array.from({ length: 8 }, (_, i) => (bytes[i * 2]! << 8) | bytes[i * 2 + 1]!);
  // the longest run of zero words (the first on a tie), compressed when it is at least two long
  let best = { base: -1, len: 0 };
  for (let i = 0; i < 8; ) {
    if (words[i] !== 0) {
      i++;
      continue;
    }
    let len = 0;
    while (i + len < 8 && words[i + len] === 0) len++;
    if (len > best.len) best = { base: i, len };
    i += len;
  }
  if (best.len < 2) best = { base: -1, len: 0 };
  let out = "";
  for (let i = 0; i < 8; i++) {
    if (best.base !== -1 && i >= best.base && i < best.base + best.len) {
      if (i === best.base) out += ":";
      continue;
    }
    if (i !== 0) out += ":";
    // an encapsulated IPv4 address prints its last two words as a dotted quad
    if (
      i === 6 &&
      best.base === 0 &&
      (best.len === 6 || (best.len === 7 && words[7] !== 1) || (best.len === 5 && words[5] === 0xffff))
    ) {
      return `${out}${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    }
    out += words[i]!.toString(16);
  }
  // a compressed run that reaches the end of the address leaves a trailing "::"
  return best.base !== -1 && best.base + best.len === 8 ? `${out}:` : out;
}

/** The text output of `inet` (the mask length is left out when it covers the whole address) and `cidr` (always shown). */
export function formatNetwork(type: NetworkType, value: NetworkValue): string {
  const address = value.bytes.length === 4 ? Array.from(value.bytes).join(".") : formatIpv6(value.bytes);
  return type === "inet" && value.bits === value.bytes.length * 8 ? address : `${address}/${value.bits}`;
}

/** `inet::text`: unlike the output function, the mask length is always shown. */
export function networkCastText(text: string): string {
  return text.includes("/") ? text : `${text}/${parseCanonical(text).bits}`;
}

export function networkInput(type: NetworkType, input: string): string {
  return formatNetwork(type, parseNetwork(type, input.trim()));
}

/** The canonical text of a stored `inet` / `cidr` datum as a parsed value (lossless for either type). */
function parseCanonical(text: string): NetworkValue {
  const slash = text.indexOf("/");
  const address = slash === -1 ? text : text.slice(0, slash);
  const bytes = address.includes(":") ? parseIpv6(address)! : parseIpv4(address)!;
  return { bytes, bits: slash === -1 ? bytes.length * 8 : Number(text.slice(slash + 1)) };
}

const maskedBytes = (value: NetworkValue, fill: number): Uint8Array =>
  Uint8Array.from(value.bytes, (byte, i) => {
    const kept = Math.max(0, Math.min(8, value.bits - i * 8));
    const mask = (0xff << (8 - kept)) & 0xff;
    return (byte & mask) | (fill & ~mask & 0xff);
  });

/** The `cidr` of an `inet`: the network it names, host bits cleared. */
export function networkToCidr(text: string): string {
  const value = parseCanonical(text);
  return formatNetwork("cidr", { bytes: maskedBytes(value, 0), bits: value.bits });
}

/** `broadcast()` (host bits set) and `netmask()` (mask bits set) of an `inet`, as `inet` text. */
export function networkBroadcast(text: string): string {
  const value = parseCanonical(text);
  return formatNetwork("inet", { bytes: maskedBytes(value, 0xff), bits: value.bits });
}

export function networkNetmask(text: string): string {
  const value = parseCanonical(text);
  const mask = maskedBytes({ bytes: new Uint8Array(value.bytes.length).fill(0xff), bits: value.bits }, 0);
  return formatNetwork("inet", { bytes: mask, bits: value.bytes.length * 8 });
}

/** `inet` ordering: address family, then the network part up to the shorter mask, then mask length, then the address. */
export function networkCompare(a: string, b: string): number {
  const x = parseCanonical(a);
  const y = parseCanonical(b);
  if (x.bytes.length !== y.bytes.length) return x.bytes.length < y.bytes.length ? -1 : 1;
  const prefix = (bits: number): number => {
    for (let i = 0; i < x.bytes.length; i++) {
      const masked = Math.max(0, Math.min(8, bits - i * 8));
      const mask = (0xff << (8 - masked)) & 0xff;
      const diff = (x.bytes[i]! & mask) - (y.bytes[i]! & mask);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    return 0;
  };
  const network = prefix(Math.min(x.bits, y.bits));
  if (network !== 0) return network;
  if (x.bits !== y.bits) return x.bits < y.bits ? -1 : 1;
  return prefix(x.bytes.length * 8);
}

/** Dotted/colon text of a network address with its mask applied, for the network-address functions. */
export function networkParts(text: string): NetworkValue {
  return parseCanonical(text);
}

// --- macaddr ----------------------------------------------------------------

const MAC_FORMS: RegExp[] = [
  /^([0-9a-f]{1,2})([:-])([0-9a-f]{1,2})\2([0-9a-f]{1,2})\2([0-9a-f]{1,2})\2([0-9a-f]{1,2})\2([0-9a-f]{1,2})$/i,
  /^([0-9a-f]{6})[:-]([0-9a-f]{6})$/i,
  /^([0-9a-f]{4})([.-])([0-9a-f]{4})\2([0-9a-f]{4})$/i,
  /^([0-9a-f]{12})$/i,
];

export function macaddrInput(input: string): string {
  const text = input.trim();
  let digits: string | null = null;
  const six = MAC_FORMS[0]!.exec(text);
  if (six) digits = [six[1], six[3], six[4], six[5], six[6], six[7]].map((g) => g!.padStart(2, "0")).join("");
  else {
    const split = MAC_FORMS[1]!.exec(text);
    const dotted = MAC_FORMS[2]!.exec(text);
    const plain = MAC_FORMS[3]!.exec(text);
    if (split) digits = split[1]! + split[2]!;
    else if (dotted) digits = dotted[1]! + dotted[3]! + dotted[4]!;
    else if (plain) digits = plain[1]!;
  }
  if (digits === null) return invalidInput("macaddr", input);
  return digits.toLowerCase().replace(/(..)(?=.)/g, "$1:");
}
