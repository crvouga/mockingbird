/**
 * Bots. The server runs a Bot's deployed code in a VM context, Lambda or Fission
 * (bots/execute.ts); the emulator runs the suite's own `bots` handler in its place. What
 * surrounds it is the server's: `$execute` routing and checks (fhir/operations/execute.ts), the
 * Bot branch of the subscription worker (workers/subscription.ts), and `sendBotResponse`
 * (bots/utils.ts).
 */
import {
  allOk,
  badRequest,
  ContentType,
  getStatus,
  isOk,
  isOperationOutcome,
  isResource,
  normalizeOperationOutcome,
  stringify,
  type WithId,
} from "@medplum/core"
import type {
  Bot,
  OperationOutcome,
  ProjectMembership,
  ProjectSetting,
  Reference,
  Resource,
  Subscription,
} from "@medplum/fhirtypes"
import { FHIR_JSON, type RequestIds, respond, sendOutcome } from "./http.js"

/** What a Bot's `handler(medplum, event)` receives besides its input, plus what it would build `medplum` from. */
export type MedplumBotContext = {
  /** The input's content type: the request's for `$execute`, `application/fhir+json` for a subscription. */
  contentType: string
  /**
   * Who triggered the bot: the caller's profile for `$execute` (the member named by
   * `X-Medplum-On-Behalf-Of` when the caller sends it), the triggering resource's `meta.author`
   * for a subscription.
   */
  requester?: Reference | undefined
  /** The membership the bot runs as: its own, or the requester's when `runAsUser` is set. */
  runAs: WithId<ProjectMembership>
  /** The emulator's base URL and a bearer token for `runAs`, to build a `MedplumClient` from. */
  baseUrl: string
  accessToken: string
  /** The project secrets, by name. */
  secrets: Record<string, ProjectSetting>
  /** The request's headers for `$execute`; the rest-hook headers for a subscription. */
  headers: Record<string, string>
  traceId: string
  /** The subscription that fired, and the interaction that matched it. */
  subscription?: WithId<Subscription> | undefined
  interaction?: "create" | "update" | "delete" | undefined
}

/**
 * Runs a Bot: `input` is the `$execute` body (the query for a GET), or the triggering resource
 * (`{ deletedResource }` on delete) for a subscription. The return value is the bot's.
 */
export type MedplumBotHandler = (
  bot: WithId<Bot>,
  input: unknown,
  context: MedplumBotContext,
) => unknown

/** `BotExecutionResult`. */
export type BotResult = { success: boolean; logResult: string; returnValue?: unknown }

export const BOTS_NOT_EMULATED =
  "Bot execution is not emulated: pass a `bots` handler to the emulator"

/** `runInVmContext`'s outcome for a handler: a throw is a failure carrying its OperationOutcome. */
export const runBotHandler = async (
  handler: MedplumBotHandler,
  bot: WithId<Bot>,
  input: unknown,
  context: MedplumBotContext,
): Promise<BotResult> => {
  let result: BotResult
  try {
    result = { success: true, logResult: "", returnValue: await handler(bot, input, context) }
  } catch (error) {
    result = { success: false, logResult: "", returnValue: normalizeOperationOutcome(error) }
  }
  // `normalizeBotExecutionResult`: a returned error outcome is a failure.
  if (isOperationOutcome(result.returnValue) && !isOk(result.returnValue))
    return { ...result, success: false }
  return result
}

const MIRRORED_CONTENT_TYPES: string[] = [ContentType.TEXT, ContentType.HL7_V2]

/** `sendBotResponse` (bots/utils.ts). */
export const botResponse = (
  result: BotResult,
  requestContentType: string | null,
  ids: RequestIds,
): Response => {
  let body = result.returnValue
  if (body === undefined) body = result.success ? allOk : badRequest(result.logResult)
  else if (typeof body === "number") body = body.toString()
  if (isOperationOutcome(body) && !isOk(body)) return sendOutcome(body as OperationOutcome, ids)
  const status = getStatus(result.success ? allOk : badRequest(result.logResult))
  if (isResource(body)) {
    const resource = body as Resource
    const headers: Record<string, string> = {}
    if (resource.meta?.versionId) headers.etag = `W/"${resource.meta.versionId}"`
    if (resource.meta?.lastUpdated)
      headers["last-modified"] = new Date(resource.meta.lastUpdated).toUTCString()
    return respond(status, stringify(resource), FHIR_JSON, headers)
  }
  const type = (requestContentType ?? "").split(";")[0]?.trim() ?? ""
  const contentType = MIRRORED_CONTENT_TYPES.includes(type) ? type : ContentType.JSON
  // Express `res.send`: strings as they are, anything else as JSON, either way in UTF-8.
  return respond(
    status,
    typeof body === "string" ? body : JSON.stringify(body),
    `${contentType}; charset=utf-8`,
  )
}
