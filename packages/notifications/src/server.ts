/// <reference types="node" />
import { readFile } from "node:fs/promises"
import { listen } from "@crvouga/mockingbird-adapter-node"
import type { FleetManifest } from "./discovery.js"
import {
  createNotificationHarness,
  type HarnessOptions,
  type NotificationHarness,
} from "./harness.js"

/** Port `mockingbird-notifications serve` listens on when none is given. */
export const DEFAULT_PORT = 8790

export type NotificationServerOptions = Omit<HarnessOptions, "manifest"> & {
  /** A fleet ready manifest object, or the path of the fleet's `--ready-file` (re-read every sync). */
  manifest?: HarnessOptions["manifest"] | string
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type NotificationServer = {
  url: string
  port: number
  harness: NotificationHarness
  close(): Promise<void>
}

/** A manifest loader that re-reads the fleet's ready file, so a restarted fleet is picked up. */
export const manifestFile = (path: string) => async (): Promise<FleetManifest> =>
  JSON.parse(await readFile(path, "utf8")) as FleetManifest

export const createServer = async (
  options: NotificationServerOptions = {},
): Promise<NotificationServer> => {
  const { port, host, manifest, ...rest } = options
  const harness = createNotificationHarness({
    ...rest,
    ...(manifest === undefined
      ? {}
      : { manifest: typeof manifest === "string" ? manifestFile(manifest) : manifest }),
  })
  const listening = await listen(harness, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return {
    url: listening.url,
    port: listening.port,
    harness,
    close: async () => {
      harness.close()
      await listening.close()
    },
  }
}
