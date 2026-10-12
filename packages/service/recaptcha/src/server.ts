/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type RecaptchaRuntime, type RecaptchaRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 12123
export type RecaptchaServerOptions = RecaptchaRuntimeOptions & { port?: number; host?: string }
export type RecaptchaServer = Listening & { runtime: RecaptchaRuntime }
export const createServer = async (
  options: RecaptchaServerOptions = {},
): Promise<RecaptchaServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })
  return { ...listening, runtime }
}
export const serveTarget: ServeTarget = {
  name: "recaptcha",
  defaultPort: DEFAULT_PORT,
  options: {},
  create: (_values, common) =>
    createRuntime({
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => [
    "fixtures: site key mock_site; secret mock_secret",
    "browser: /recaptcha/api.js?render=mock_site",
  ],
}
