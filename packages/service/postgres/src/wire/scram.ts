import { digestBytes } from "../functions/pgcrypto.ts";

/*
 * SHA-256, HMAC and PBKDF2 are the engine's own pure implementations rather than `node:crypto`,
 * so the wire server runs where no Node built-in exists (a browser or edge worker). Randomness
 * comes from `crypto.getRandomValues`, a global in browsers, workers, Node 20+, Bun and Deno.
 */
const utf8 = new TextEncoder();
const sha256 = (data: Uint8Array): Uint8Array => digestBytes(data, "sha256");

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
};

/** HMAC-SHA-256 (RFC 2104) keyed by `key`. Returns a function, so PBKDF2 reuses the padded keys. */
const hmacSha256 = (key: Uint8Array): ((message: Uint8Array) => Uint8Array) => {
  const block = new Uint8Array(64);
  block.set(key.byteLength > 64 ? sha256(key) : key);
  const inner = block.map((byte) => byte ^ 0x36);
  const outer = block.map((byte) => byte ^ 0x5c);
  return (message) => sha256(concat(outer, sha256(concat(inner, message))));
};

/** PBKDF2-HMAC-SHA-256 (RFC 8018) for one 32-byte block, which is all SCRAM-SHA-256 needs. */
const pbkdf2Sha256 = (password: Uint8Array, salt: Uint8Array, iterations: number): Uint8Array => {
  const prf = hmacSha256(password);
  let u = prf(concat(salt, new Uint8Array([0, 0, 0, 1])));
  const out = u.slice();
  for (let i = 1; i < iterations; i++) {
    u = prf(u);
    for (let j = 0; j < out.byteLength; j++) out[j] = (out[j] as number) ^ (u[j] as number);
  }
  return out;
};

const randomBytes = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length));

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const toBase64 = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.byteLength; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += BASE64[(n >> 18) & 63];
    out += BASE64[(n >> 12) & 63];
    out += b === undefined ? "=" : BASE64[(n >> 6) & 63];
    out += c === undefined ? "=" : BASE64[n & 63];
  }
  return out;
};

/** Decode standard base64; null when `text` is not well-formed. */
const fromBase64 = (text: string): Uint8Array | null => {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let at = 0;
  for (let i = 0; i < text.length; i += 4) {
    const n =
      (BASE64.indexOf(text[i] as string) << 18) |
      (BASE64.indexOf(text[i + 1] as string) << 12) |
      (Math.max(0, BASE64.indexOf(text[i + 2] as string)) << 6) |
      Math.max(0, BASE64.indexOf(text[i + 3] as string));
    for (const byte of [(n >> 16) & 255, (n >> 8) & 255, n & 255]) if (at < out.byteLength) out[at++] = byte;
  }
  return out;
};

/** Compare without an early exit, as `timingSafeEqual` does. */
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
};

/** What PostgreSQL keeps in `pg_authid.rolpassword` for a SCRAM-SHA-256 role: `SCRAM-SHA-256$<i>:<salt>$<StoredKey>:<ServerKey>`. */
export type ScramCredentials = {
  readonly salt: Uint8Array;
  readonly iterations: number;
  readonly storedKey: Uint8Array;
  readonly serverKey: Uint8Array;
};

/** PostgreSQL's default `scram_iterations`. */
export const SCRAM_ITERATIONS = 4096;

/** The one expensive step of SCRAM: PBKDF2 over the password, then the two keys a verifier stores. */
export const deriveScramCredentials = (
  password: string,
  salt: Uint8Array,
  iterations: number = SCRAM_ITERATIONS,
): ScramCredentials => {
  const salted = hmacSha256(pbkdf2Sha256(utf8.encode(password), salt, iterations));
  return {
    salt,
    iterations,
    storedKey: sha256(salted(utf8.encode("Client Key"))),
    serverKey: salted(utf8.encode("Server Key")),
  };
};

/**
 * Per-role SCRAM verifiers, derived once like PostgreSQL's `pg_authid`: a role gets a stable random
 * salt and its StoredKey/ServerKey on first use, so later connections compute only HMACs. A new
 * password for the role derives a new verifier (and a new salt), as `ALTER ROLE … PASSWORD` does.
 */
export class ScramCredentialStore {
  private readonly roles = new Map<string, { password: string; credentials: ScramCredentials }>();

  /** `derive` is the PBKDF2 step; tests inject a counting wrapper. */
  constructor(
    private readonly derive: (
      password: string,
      salt: Uint8Array,
      iterations: number,
    ) => ScramCredentials = deriveScramCredentials,
  ) {}

  /** The verifier for `user` with `password`, derived on first use and whenever the password changes. */
  credentials(user: string, password: string): ScramCredentials {
    const cached = this.roles.get(user);
    if (cached && cached.password === password) return cached.credentials;
    const credentials = this.derive(password, randomBytes(16), SCRAM_ITERATIONS);
    this.roles.set(user, { password, credentials });
    return credentials;
  }
}

/**
 * Server side of SCRAM-SHA-256 (RFC 7677) as PostgreSQL speaks it: one round trip after the
 * client's first message, channel binding declined (`n` or `y`; no TLS here).
 *
 * Pass the server's {@link ScramCredentialStore} so the PBKDF2 step runs once per role rather
 * than once per connection; without one each instance derives its own verifier.
 */
export class ScramServer {
  private clientFirstBare = "";
  private serverFirst = "";
  private nonce = "";
  private verifier: ScramCredentials | null = null;

  constructor(
    private readonly password: string,
    private readonly user = "postgres",
    private readonly store: ScramCredentialStore = new ScramCredentialStore(),
  ) {}

  /** The server-first-message for a client-first-message; null when the client message is malformed. */
  first(clientFirst: string): string | null {
    const m = /^([nyp])(=[^,]*)?,([^,]*),(.*)$/s.exec(clientFirst);
    if (!m) return null;
    const bare = m[4] as string;
    const nonce = /(?:^|,)r=([^,]+)/.exec(bare)?.[1];
    if (!nonce) return null;
    const verifier = this.store.credentials(this.user, this.password);
    this.verifier = verifier;
    this.clientFirstBare = bare;
    this.nonce = nonce + toBase64(randomBytes(18));
    this.serverFirst = `r=${this.nonce},s=${toBase64(verifier.salt)},i=${verifier.iterations}`;
    return this.serverFirst;
  }

  /** The server-final-message (`v=…`) when the client's proof is right; null otherwise. */
  final(clientFinal: string): string | null {
    const verifier = this.verifier;
    if (verifier === null) return null;
    const proofAt = clientFinal.lastIndexOf(",p=");
    if (proofAt === -1) return null;
    const withoutProof = clientFinal.slice(0, proofAt);
    const proof = fromBase64(clientFinal.slice(proofAt + 3));
    if (proof === null) return null;
    const nonce = /(?:^|,)r=([^,]+)/.exec(withoutProof)?.[1];
    if (nonce !== this.nonce) return null;
    const authMessage = utf8.encode(`${this.clientFirstBare},${this.serverFirst},${withoutProof}`);
    const clientSignature = hmacSha256(verifier.storedKey)(authMessage);
    if (proof.byteLength !== clientSignature.byteLength) return null;
    const recovered = new Uint8Array(clientSignature.byteLength);
    for (let i = 0; i < recovered.byteLength; i++) {
      recovered[i] = (proof[i] as number) ^ (clientSignature[i] as number);
    }
    if (!sameBytes(sha256(recovered), verifier.storedKey)) return null;
    return `v=${toBase64(hmacSha256(verifier.serverKey)(authMessage))}`;
  }
}
