/// <reference types="node" />
import { readFileSync } from "node:fs"
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { appendSurveys, parseBootSettings, parseSurveysDocument } from "./boot.js"
import { createRuntime, type FormbricksRuntime, type FormbricksRuntimeOptions } from "./runtime.js"
import { CORPUS_SURVEYS, DEFAULT_SETTINGS, type Settings, type Survey } from "./state.js"

/** Port `mockingbird-formbricks serve` listens on when none is given. */
export const DEFAULT_PORT = 8813

export type FormbricksServerOptions = FormbricksRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type FormbricksServer = Listening & { runtime: FormbricksRuntime }

/** Serve the Formbricks mock over `node:http`. */
export const createServer = async (
  options: FormbricksServerOptions = {},
): Promise<FormbricksServer> => {
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

/**
 * Read a surveys file (a list, or `{surveys: [...]}`) and lay it after the corpus surveys
 * (`append`, the default; a survey whose id the corpus or an earlier row has is skipped) or use it
 * as the whole corpus (`replace`). A survey without a `workspaceId` is served by every workspace.
 */
export const loadSurveysFile = (
  path: string,
  mode: "append" | "replace" = "append",
  legacyEnvironmentIds: Record<string, string> = DEFAULT_SETTINGS.legacyEnvironmentIds,
): Survey[] => {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    throw new Error(`formbricks surveys not found: ${path}`)
  }
  try {
    const surveys = parseSurveysDocument(JSON.parse(raw), legacyEnvironmentIds)
    return appendSurveys(mode === "replace" ? [] : CORPUS_SURVEYS, surveys)
  } catch (error) {
    throw new Error(`formbricks surveys ${path}: ${(error as Error).message}`)
  }
}

/** How `serve` (and `serve --config`) builds the Formbricks mock from flags. */
export const serveTarget: ServeTarget = {
  name: "formbricks",
  defaultPort: DEFAULT_PORT,
  parseSettings: (settings) => parseBootSettings(settings),
  options: {
    "webhook-url": {
      type: "string",
      value: "<url>",
      description: "Deliver webhooks here (e.g. http://127.0.0.1:3000/webhooks/formbricks)",
    },
    "webhook-token": {
      type: "string",
      value: "<token>",
      description: "Appended to the webhook url as ?token= (for receivers that check one)",
    },
    "webhook-secret": {
      type: "string",
      value: "<whsec_…>",
      description: "Standard Webhooks key that signs webhook-signature (optional)",
    },
    "workspace-id": {
      type: "string",
      value: "<id>",
      description: "An extra workspace id that serves the survey corpus",
    },
    surveys: {
      type: "string",
      value: "<file.json>",
      description:
        "Surveys every namespace starts with, as a list or {surveys: [...]}, added after the corpus surveys (a repeated id is skipped)",
    },
    "surveys-mode": {
      type: "string",
      value: "<append|replace>",
      description:
        "With --surveys: add to the corpus (default) or use the file as the whole corpus",
    },
  },
  create: (values, common) => {
    const url = text(values["webhook-url"])
    const token = text(values["webhook-token"])
    const secret = text(values["webhook-secret"])
    const workspace = text(values["workspace-id"])
    const surveysPath = text(values.surveys)
    const mode = text(values["surveys-mode"])
    if (mode !== undefined && mode !== "append" && mode !== "replace")
      throw new Error('--surveys-mode must be "append" or "replace"')
    if (mode !== undefined && surveysPath === undefined)
      throw new Error("--surveys-mode needs --surveys")
    const boot = common.settings as Partial<Settings> | undefined
    const settings: Partial<Settings> = {
      ...boot,
      ...(workspace
        ? { workspaces: [workspace, ...(boot?.workspaces ?? DEFAULT_SETTINGS.workspaces)] }
        : {}),
    }
    const target =
      url && token
        ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`
        : url
    return createRuntime({
      ...(target ? { webhooks: { url: target, ...(secret ? { secret } : {}) } } : {}),
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
      ...(surveysPath
        ? {
            surveys: loadSurveysFile(
              surveysPath,
              mode,
              settings.legacyEnvironmentIds ?? DEFAULT_SETTINGS.legacyEnvironmentIds,
            ),
          }
        : {}),
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    `point the SDK's appUrl at this url; workspace ${DEFAULT_SETTINGS.workspaces[0]} (legacy environment ${Object.keys(DEFAULT_SETTINGS.legacyEnvironmentIds)[0]}) serves the survey corpus`,
    "management API: x-api-key <any>; namespaces: x-mockingbird-namespace, /__admin/ns/<name>/…, or PUT /__admin/credentials {<workspace id | api key>: <ns>}",
  ],
}
