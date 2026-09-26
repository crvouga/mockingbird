import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Server side of SCRAM-SHA-256 (RFC 7677) as PostgreSQL speaks it: one round trip after the
 * client's first message, channel binding declined (`n` or `y`; no TLS here).
 */
export class ScramServer {
  private clientFirstBare = "";
  private serverFirst = "";
  private nonce = "";
  private readonly salt = randomBytes(16);
  private readonly iterations = 4096;

  constructor(private readonly password: string) {}

  /** The server-first-message for a client-first-message; null when the client message is malformed. */
  first(clientFirst: string): string | null {
    const m = /^([nyp])(=[^,]*)?,([^,]*),(.*)$/s.exec(clientFirst);
    if (!m) return null;
    const bare = m[4] as string;
    const nonce = /(?:^|,)r=([^,]+)/.exec(bare)?.[1];
    if (!nonce) return null;
    this.clientFirstBare = bare;
    this.nonce = nonce + randomBytes(18).toString("base64");
    this.serverFirst = `r=${this.nonce},s=${this.salt.toString("base64")},i=${this.iterations}`;
    return this.serverFirst;
  }

  /** The server-final-message (`v=…`) when the client's proof is right; null otherwise. */
  final(clientFinal: string): string | null {
    const proofAt = clientFinal.lastIndexOf(",p=");
    if (proofAt === -1) return null;
    const withoutProof = clientFinal.slice(0, proofAt);
    const proof = Buffer.from(clientFinal.slice(proofAt + 3), "base64");
    const nonce = /(?:^|,)r=([^,]+)/.exec(withoutProof)?.[1];
    if (nonce !== this.nonce) return null;
    const salted = pbkdf2Sync(this.password, this.salt, this.iterations, 32, "sha256");
    const clientKey = createHmac("sha256", salted).update("Client Key").digest();
    const storedKey = createHash("sha256").update(clientKey).digest();
    const authMessage = `${this.clientFirstBare},${this.serverFirst},${withoutProof}`;
    const clientSignature = createHmac("sha256", storedKey).update(authMessage).digest();
    if (proof.byteLength !== clientSignature.byteLength) return null;
    const recovered = Buffer.alloc(clientKey.byteLength);
    for (let i = 0; i < recovered.byteLength; i++) {
      recovered[i] = (proof[i] as number) ^ (clientSignature[i] as number);
    }
    const recoveredStored = createHash("sha256").update(recovered).digest();
    if (!timingSafeEqual(recoveredStored, storedKey)) return null;
    const serverKey = createHmac("sha256", salted).update("Server Key").digest();
    const serverSignature = createHmac("sha256", serverKey).update(authMessage).digest();
    return `v=${serverSignature.toString("base64")}`;
  }
}
