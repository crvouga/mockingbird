import type { FleetDashboardStarter, MockingbirdConfig } from "@crvouga/mockingbird-adapter-node"

/** Port the dashboard listens on when none is given: the notifications harness's own default. */
export const DASHBOARD_PORT = 8790

export type FleetDashboardOptions = {
  /** Default {@link DASHBOARD_PORT} (8790). `0` picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
  /** Shown in the tab bar and the page title. Default `Mockingbird`. */
  title?: string
  /** The tab the page opens on. Default `emulators`. */
  defaultTab?: "emulators" | "notifications"
  /** How often the notifications tab reads the emulators. Default 750 ms. */
  pollIntervalMs?: number
}

/** `dashboard` as a fleet configuration or `startFleet` gives it, as options; undefined when off. */
export const dashboardOptions = (
  value: MockingbirdConfig["dashboard"] | FleetDashboardOptions | undefined,
): FleetDashboardOptions | undefined => (value ? (value === true ? {} : value) : undefined)

/**
 * The dashboard for a fleet: every emulator's admin UI and the notifications UI on one page, on
 * one port of its own. It reads the fleet through its controller, so emulators that restart or
 * join later are followed, and it sends the fleet's admin keys itself.
 *
 *   const fleet = await startFleet(config, { load, dashboard: fleetDashboard({ port: 0 }) })
 *   fleet.manifest.dashboard   // http://127.0.0.1:53124
 */
export const fleetDashboard =
  (options: FleetDashboardOptions = {}): FleetDashboardStarter =>
  async ({ manifest, config }) => {
    const port = options.port ?? DASHBOARD_PORT
    const adminKeys = Object.fromEntries(
      Object.entries(config.services).flatMap(([name, entry]) =>
        entry.adminKey ? [[name, entry.adminKey]] : [],
      ),
    )
    // Loaded on demand: a fleet without a dashboard never reads the admin UI bundle.
    const { createServer } = await import("@crvouga/mockingbird-notifications/server")
    try {
      const server = await createServer({
        fleet: manifest.adminBase,
        port,
        title: options.title ?? "Mockingbird",
        defaultTab: options.defaultTab ?? "emulators",
        ...(options.host !== undefined ? { host: options.host } : {}),
        ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
        ...(config.adminKey ? { adminKey: config.adminKey } : {}),
        ...(Object.keys(adminKeys).length ? { adminKeys } : {}),
      })
      return { url: server.url, close: () => server.close() }
    } catch (error) {
      if ((error as { code?: unknown }).code === "EADDRINUSE")
        throw new Error(
          `dashboard: port ${port} is in use; choose another with --dashboard-port or "dashboard": { "port": … } (0 picks a free one)`,
        )
      throw error
    }
  }
