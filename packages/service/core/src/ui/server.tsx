/**
 * Pages the shared service runtime serves as strings, rendered with React. Prebuilt into
 * `dist-ui/server.js` (packages/ui/scripts/bundle.ts) and reached only through a dynamic
 * `import("@crvouga/mockingbird-service/ui")`, so React never loads on an emulator's hot path.
 */
import { renderPage } from "@crvouga/mockingbird-ui/react/server"
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import { FleetConsole, type FleetConsoleProps } from "./fleet-console.js"

export type { FleetConsoleProps } from "./fleet-console.js"

/** The fleet console. `client` is `BUNDLE` from `@crvouga/mockingbird-service/ui/client-bundle`. */
export function fleetConsolePage(
  props: { base: string; dashboard?: string },
  client?: { source: string },
): string {
  const serializable: FleetConsoleProps = {
    base: props.base,
    ...(props.dashboard ? { dashboard: props.dashboard } : {}),
  }
  return renderPage(<FleetConsole {...serializable} />, {
    title: "Fleet console",
    css: MOCKINGBIRD_CSS,
    rememberTheme: true,
    ...(client
      ? {
          script: {
            source: client.source,
            call: "MockingbirdService.mountFleetConsole",
            props: serializable,
          },
        }
      : {}),
  })
}
