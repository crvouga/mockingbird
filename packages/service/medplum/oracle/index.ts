/**
 * The parity oracle: a real, self-hosted Medplum server (the pinned version, built once from
 * source into ~/.cache/mockingbird/medplum-server) on embedded Postgres and a throwaway Redis,
 * behind the same `fetch(Request)` shape as the mock. Dev-only — Node child processes, never
 * part of the published package.
 */
import { SUPER_ADMIN_CLIENT_ID, SUPER_ADMIN_CLIENT_SECRET } from "./config.js"
import { type MedplumProcessOptions, MedplumServerProcess } from "./process.js"

export {
  SUPER_ADMIN_CLIENT_ID,
  SUPER_ADMIN_CLIENT_SECRET,
  SUPER_ADMIN_EMAIL,
  SUPER_ADMIN_PASSWORD,
} from "./config.js"
export { resolveMedplumPaths } from "./paths.js"

export class MedplumOracle {
  private readonly process: MedplumServerProcess

  constructor(options: MedplumProcessOptions = {}) {
    this.process = new MedplumServerProcess(options)
  }

  async start(): Promise<void> {
    await this.process.start()
  }

  async stop(): Promise<void> {
    await this.process.stop()
  }

  /** Stop the server, drop the database, and boot it again on the fresh seed (a server boot). */
  async reset(): Promise<void> {
    await this.process.reset()
  }

  get isStarted(): boolean {
    return this.process.isStarted
  }

  /** `http://127.0.0.1:<port>/`, the server's `config.baseUrl`. */
  get baseUrl(): string {
    return this.process.baseUrl
  }

  /** Send `request` to the server; only its path and query are used, so any origin works. */
  fetch(request: Request): Promise<Response> {
    const incoming = new URL(request.url)
    const target = new URL(this.process.baseUrl)
    target.pathname = incoming.pathname
    target.search = incoming.search
    const headers = new Headers(request.headers)
    headers.delete("host")
    headers.delete("connection")
    headers.delete("content-length")
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers,
      redirect: "manual",
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body
      init.duplex = "half"
    }
    return fetch(new Request(target, init))
  }
}

/** Boot an oracle (clones and builds Medplum on the very first run: minutes). */
export const startOracle = async (options: MedplumProcessOptions = {}): Promise<MedplumOracle> => {
  const oracle = new MedplumOracle(options)
  await oracle.start()
  return oracle
}

export {
  SUPER_ADMIN_CLIENT_ID as ORACLE_SUPER_ADMIN_CLIENT_ID,
  SUPER_ADMIN_CLIENT_SECRET as ORACLE_SUPER_ADMIN_CLIENT_SECRET,
}
