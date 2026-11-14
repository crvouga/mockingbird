/** Raw-fetch application client: no vendor JavaScript SDK is used by the reporter. */
export class WearablesConsumer {
  constructor(
    private readonly origin: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    return this.fetchImpl(this.origin + path, {
      method,
      headers: { "X-Open-Wearables-API-Key": this.key, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
}
