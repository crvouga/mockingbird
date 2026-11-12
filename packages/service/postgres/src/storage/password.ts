import { digestBytes } from "../functions/pgcrypto.ts";

/**
 * The SCRAM-SHA-256 verifier PostgreSQL stores in `pg_authid.rolpassword` for `PASSWORD 'secret'`
 * (password_encryption = scram-sha-256): `SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>`. A
 * password given already encrypted (a SCRAM verifier or an `md5` hash) is kept as written.
 */

const utf8 = new TextEncoder();
const sha256 = (data: Uint8Array): Uint8Array => digestBytes(data, "sha256");

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function hmac(key: Uint8Array): (message: Uint8Array) => Uint8Array {
  const block = new Uint8Array(64);
  block.set(key.byteLength > 64 ? sha256(key) : key);
  const inner = block.map((b) => b ^ 0x36);
  const outer = block.map((b) => b ^ 0x5c);
  return (message) => sha256(concat(outer, sha256(concat(inner, message))));
}

function base64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.byteLength; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]!;
    out += b === undefined ? "=" : alphabet[(n >> 6) & 63]!;
    out += c === undefined ? "=" : alphabet[n & 63]!;
  }
  return out;
}

const ITERATIONS = 4096;

export function isEncryptedPassword(password: string): boolean {
  return /^SCRAM-SHA-256\$\d+:/.test(password) || /^md5[0-9a-f]{32}$/.test(password);
}

/** The stored form of `password`; `salt` is 16 bytes (drawn from the session's generator by the caller). */
export function encryptPassword(password: string, salt: Uint8Array): string {
  if (isEncryptedPassword(password)) return password;
  const prf = hmac(utf8.encode(password));
  let u = prf(concat(salt, new Uint8Array([0, 0, 0, 1])));
  const salted = u.slice();
  for (let i = 1; i < ITERATIONS; i++) {
    u = prf(u);
    for (let j = 0; j < salted.byteLength; j++) salted[j] = salted[j]! ^ u[j]!;
  }
  const key = hmac(salted);
  const storedKey = sha256(key(utf8.encode("Client Key")));
  const serverKey = key(utf8.encode("Server Key"));
  return `SCRAM-SHA-256$${ITERATIONS}:${base64(salt)}$${base64(storedKey)}:${base64(serverKey)}`;
}
