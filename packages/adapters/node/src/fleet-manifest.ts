/** Public readiness contract, usable before workspace packages have been built. */
export type EndpointManifest = {
  version: 1
  capabilityVersion?: 1
  state: "ready" | "recovery-required"
  pid: number
  id: string
  startedAt: string
  adminBase: string
  healthUrl: string
  services: Record<
    string,
    {
      protocol: "http" | "postgres" | "redis" | "external"
      url: string
      healthUrl: string
      adminUrl: string
      namespaces: Record<string, unknown>
      processReady: boolean
      protocolReady: boolean
    }
  >
}
