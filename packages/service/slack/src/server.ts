/// <reference types="node" />
import {
  type Listening,
  listen,
  providerServeOptions,
  providerServeValues,
  type ServeTarget,
} from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type SlackRuntime, type SlackRuntimeOptions } from "./runtime.js"
import { attachSocketServer } from "./socket-server.js"

/** Port `mockingbird-slack serve` listens on when none is given. */
export const DEFAULT_PORT = 8808

export type SlackServerOptions = SlackRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type SlackServer = Listening & { runtime: SlackRuntime }

/** Serve the Slack mock over `node:http`. */
export const createServer = async (options: SlackServerOptions = {}): Promise<SlackServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  attachSocketServer(listening.server)
  return { ...listening, runtime }
}

const text = (value: string | boolean | undefined) =>
  typeof value === "string" ? value : undefined

/** How `serve` (and `serve --config`) builds the Slack mock from flags. */
export const serveTarget: ServeTarget = {
  name: "slack",
  defaultPort: DEFAULT_PORT,
  options: {
    ...providerServeOptions,
    token: {
      type: "string",
      value: "<xoxb-…>",
      description:
        "Only accept this bot token on the Web API (default: any xoxb-/xoxp- token is accepted)",
    },
    "strict-channels": {
      type: "boolean",
      description: "Answer channel_not_found for channels not created through /__admin/channels",
    },
  },
  create: async (values, common) => {
    const token = text(values.token)
    return createRuntime({
      ...(await providerServeValues<NonNullable<SlackRuntimeOptions["fixtures"]>>(values, common)),
      settings: {
        ...(token ? { tokens: [token] } : {}),
        ...(values["strict-channels"] === true ? { strictChannels: true } : {}),
      },
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  listening: (listening) => {
    attachSocketServer(listening.server)
  },
  banner: () => [
    "webhooks: point SLACK_*_WEBHOOK_URL at <this>/services/T000/B000/XXXX (any path works until you POST /__admin/hooks)",
    "web api: Authorization: Bearer xoxb-…; @slack/web-api: new WebClient(token, {slackApiUrl: '<this>/api/'})",
    "socket mode: Authorization: Bearer xapp-… on POST <this>/api/apps.connections.open; Bolt: socketMode + clientOptions.slackApiUrl '<this>/api/'",
    "outbox: GET /__admin/outbox?webhook=/services/T/B/X or ?channel=C…",
  ],
}
