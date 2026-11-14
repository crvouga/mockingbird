/** Socket-free helpers for a host-provided firebase-admin HTTP transport. */
export const fcmHosts = ["fcm.googleapis.com"] as const

/** A local credential; set projectId separately in initializeApp. Never fetches OAuth tokens. */
export const createAdminCredential = (options: { token?: string } = {}) => ({
  getAccessToken: async () => ({
    access_token: options.token ?? "fixture-token",
    expires_in: 3_600,
  }),
})

/** Route only the HTTP v1 send surface, leaving other destinations to the host. */
export const routeAdminRequest =
  (runtime: { fetch(request: Request): Response | Promise<Response> }) =>
  (request: Request): Promise<Response> | undefined => {
    const url = new URL(request.url)
    if (
      url.protocol !== "https:" ||
      url.hostname !== fcmHosts[0] ||
      (url.port !== "" && url.port !== "443") ||
      request.method !== "POST" ||
      !/^\/v1\/projects\/[^/]+\/messages:send$/.test(url.pathname)
    )
      return undefined
    return Promise.resolve(runtime.fetch(request))
  }
