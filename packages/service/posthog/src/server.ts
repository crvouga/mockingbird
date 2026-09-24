/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { ACME_FLAG_STATE } from "./flag-state-fixture.js"
import { specsFromState } from "./import.js"
import { createRuntime, type PostHogRuntime, type PostHogRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-posthog serve` listens on when none is given. */
export const DEFAULT_PORT = 8795

export type PostHogServerOptions = PostHogRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type PostHogServer = Listening & { runtime: PostHogRuntime }

/** Serve the PostHog mock over `node:http`. */
export const createServer = async (options: PostHogServerOptions = {}): Promise<PostHogServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return { ...listening, runtime }
}

const text = (value: string | boolean | undefined) =>
  typeof value === "string" ? value : undefined

/** How `serve` (and `serve --config`) builds the PostHog mock from flags. */
export const serveTarget: ServeTarget = {
  name: "posthog",
  defaultPort: DEFAULT_PORT,
  options: {
    "import-flags": {
      type: "string",
      value: "<dev|prod>",
      description:
        "Seed every namespace from the bundled consumer-app docs/feature-flags/state.json (member-app project)",
    },
    "session-recording": {
      type: "boolean",
      description: "Advertise session recording ({endpoint: /s/}) in remote config",
    },
  },
  create: (values, common) => {
    const env = text(values["import-flags"])
    if (env !== undefined && env !== "dev" && env !== "prod") {
      throw new Error('--import-flags must be "dev" or "prod"')
    }
    return createRuntime({
      ...(env ? { flags: specsFromState(ACME_FLAG_STATE, { env }) } : {}),
      ...(values["session-recording"] === true ? { settings: { sessionRecording: true } } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "point POSTHOG_HOST / NEXT_PUBLIC_POSTHOG_HOST here; set flags with PUT /__admin/flags/<key>",
    "namespaces: /ns/<name> host prefix, x-mockingbird-namespace, or PUT /__admin/credentials {<phc_token>: <ns>}",
  ],
}
