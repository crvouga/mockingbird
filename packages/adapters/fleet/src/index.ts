/** Supported vendor-neutral entry point. Private implementation packages are bundled. */
import {
  type Fleet,
  type FleetDashboardStarter,
  type FleetOptions,
  type MockingbirdConfig,
  startFleet as start,
} from "@crvouga/mockingbird-adapter-node"
import { dashboardOptions, type FleetDashboardOptions, fleetDashboard } from "./dashboard.js"

export * from "@crvouga/mockingbird-adapter-node"
export {
  DASHBOARD_PORT,
  type FleetDashboardOptions,
  fleetDashboard,
} from "./dashboard.js"

export type FleetStartOptions = Omit<FleetOptions, "dashboard"> & {
  /**
   * Serve the dashboard next to the fleet: `true`, `{ port, host, title }`, or a starter of your
   * own. Default: the configuration's `dashboard`. Its URL is `fleet.manifest.dashboard`.
   */
  dashboard?: boolean | FleetDashboardOptions | FleetDashboardStarter
}

/**
 * Resolves only after every child and the aggregate control listener are healthy, and the
 * dashboard too when one is asked for (`dashboard`, here or in the configuration).
 */
export async function startFleet(
  config: MockingbirdConfig,
  options: FleetStartOptions,
): Promise<Fleet> {
  const { dashboard, ...rest } = options
  const wanted = dashboard ?? config.dashboard
  const starter =
    typeof wanted === "function"
      ? wanted
      : dashboardOptions(wanted) && fleetDashboard(dashboardOptions(wanted))
  return start(config, { ...rest, ...(starter ? { dashboard: starter } : {}) })
}
