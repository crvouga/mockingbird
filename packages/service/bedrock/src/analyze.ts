/**
 * Reading a model call: the Converse wire shape (Converse, ConverseStream) and the
 * Anthropic Messages body (InvokeModel), reduced to a {@link CallAnalysis} for matching,
 * plus the request checks Bedrock itself makes and our consumer branches on (role
 * alternation, tool pairing, assistant prefill, document-without-text, sampling params).
 */
import type { CallAnalysis, ModelOperation, StructuredRequest } from "./scripts.js"

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** A request Bedrock rejects with `ValidationException`. */
export class ValidationProblem extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ValidationProblem"
  }
}

/** Claude generations that reject a trailing assistant message (no prefill). */
const NO_PREFILL =
  /claude-(?:sonnet|opus)-4-[5-9]|claude-opus-4-1|claude-(?:sonnet|opus|haiku)-[5-9]/i
/** Claude generations that reject `temperature` and `top_p` together. */
const ONE_SAMPLING_PARAM =
  /claude-(?:sonnet|opus|haiku)-4-[5-9]|claude-opus-4-1|claude-(?:sonnet|opus|haiku)-[5-9]/i

/**
 * Models whose Converse API accepts a `cachePoint` (explicit prompt caching). Best guess from
 * https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html, matched on the
 * family inside plain, `us.` / `global.` and ARN forms; not oracle-verified.
 */
const PROMPT_CACHING =
  /claude-3-5-haiku|claude-3-5-sonnet-20241022|claude-3-7-sonnet|claude-(?:opus|sonnet|haiku|fable|mythos)-[4-9]|nova-(?:micro|lite|pro|2-lite)/i

/** The document name alphabet the Bedrock API model documents (`DocumentBlock.name`). */
const DOCUMENT_NAME = /^[a-zA-Z0-9\s\-()[\]]{1,200}$/

const DOCUMENT_NAME_MESSAGE =
  "The document file name can only contain alphanumeric characters, whitespace characters, hyphens, parentheses, and square brackets. The name can't contain more than one consecutive whitespace character."

const parseSchema = (value: unknown): unknown => {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return {}
  }
}

/** Keywords Bedrock structured output documents as unsupported, anywhere in a schema node. */
const UNSUPPORTED_KEYWORDS = ["minimum", "maximum", "multipleOf", "minLength", "maxLength"]

/** Subschema positions to walk: a keyword holding one schema, a list, or a map of them. */
const SCHEMA_SLOTS = ["items", "not", "if", "then", "else", "contains"]
const SCHEMA_LISTS = ["anyOf", "allOf", "prefixItems"]
const SCHEMA_MAPS = ["properties", "$defs", "definitions", "patternProperties"]

/**
 * The first reason Bedrock's structured-output grammar compiler refuses `schema`, or
 * `undefined`. Best guess from the documented unsupported list
 * (https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html) and the
 * messages a consumer recorded for `oneOf` and `additionalProperties`; the other messages
 * are ours. Not oracle-verified.
 */
export const unsupportedSchemaReason = (root: unknown): string | undefined => {
  const resolve = (ref: string): unknown => {
    if (ref === "#") return root
    let node: unknown = root
    for (const part of ref.slice(2).split("/")) {
      node = isRecord(node) ? node[part.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined
    }
    return node
  }
  const visit = (node: unknown, refs: string[]): string | undefined => {
    if (!isRecord(node)) return undefined
    if (node.oneOf !== undefined) return "Schema type 'oneOf' is not supported"
    for (const key of UNSUPPORTED_KEYWORDS) {
      if (node[key] !== undefined) return `Schema keyword '${key}' is not supported`
    }
    if (typeof node.minItems === "number" && node.minItems > 1) {
      return `Schema keyword 'minItems' only supports the values 0 and 1 (got ${node.minItems})`
    }
    if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
      return `For 'object' type, 'additionalProperties: ${JSON.stringify(node.additionalProperties)}' is not supported. Please set 'additionalProperties' to false`
    }
    if (
      Array.isArray(node.type) &&
      Array.isArray(node.enum) &&
      node.enum.length > 0 &&
      node.enum.every((value) => typeof value === "string")
    ) {
      return `A string-only 'enum' cannot be combined with the union type ${JSON.stringify(node.type)}`
    }
    if (typeof node.$ref === "string") {
      if (!node.$ref.startsWith("#")) {
        return `External $ref '${node.$ref}' is not supported; only internal references are`
      }
      if (refs.includes(node.$ref)) return `Recursive schemas are not supported ('${node.$ref}')`
      const problem = visit(resolve(node.$ref), [...refs, node.$ref])
      if (problem) return problem
    }
    for (const key of SCHEMA_SLOTS) {
      const problem = visit(node[key], refs)
      if (problem) return problem
    }
    for (const key of SCHEMA_LISTS) {
      for (const each of array(node[key])) {
        const problem = visit(each, refs)
        if (problem) return problem
      }
    }
    for (const key of SCHEMA_MAPS) {
      const map = node[key]
      if (!isRecord(map)) continue
      for (const each of Object.values(map)) {
        const problem = visit(each, refs)
        if (problem) return problem
      }
    }
    return undefined
  }
  return visit(root, [])
}

const textOf = (blocks: unknown[]): string =>
  blocks
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n")

type NormalMessage = {
  role: string
  /** Text of the message (text blocks only). */
  text: string
  toolUses: { id: string; name: string }[]
  toolResultIds: string[]
  hasContent: boolean
  hasDocument: boolean
  hasImage: boolean
  hasCachePoint: boolean
  chars: number
}

/** Shared tail of both analyses: turn index, tool results, last user text. */
const conversationFacts = (messages: NormalMessage[]) => {
  let lastSaid = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as NormalMessage
    if (message.role === "user" && message.hasContent) {
      lastSaid = i
      break
    }
  }
  const turnIndex = messages.slice(lastSaid + 1).filter((m) => m.role === "assistant").length
  const toolNames = new Map<string, string>()
  for (const message of messages)
    for (const use of message.toolUses) toolNames.set(use.id, use.name)
  const last = messages.at(-1)
  const toolResults =
    last?.role === "user"
      ? last.toolResultIds.map((id) => toolNames.get(id)).filter((n): n is string => !!n)
      : []
  return {
    turnIndex,
    toolResults,
    lastUserText: lastSaid >= 0 ? (messages[lastSaid] as NormalMessage).text : "",
  }
}

/** Bedrock's own conversation checks, in the order it reports them. */
const checkConversation = (messages: NormalMessage[], modelId: string, hasToolConfig: boolean) => {
  if (messages.length === 0 || messages[0]?.role !== "user") {
    throw new ValidationProblem(
      "A conversation must start with a user message. Try again with a conversation that starts with a user message.",
    )
  }
  for (let i = 1; i < messages.length; i++) {
    if (messages[i]?.role === messages[i - 1]?.role) {
      throw new ValidationProblem(
        "A conversation must alternate between user and assistant roles. Make sure the conversation alternates between user and assistant roles and try again.",
      )
    }
  }
  const usesTools = messages.some((m) => m.toolUses.length > 0 || m.toolResultIds.length > 0)
  if (usesTools && !hasToolConfig) {
    throw new ValidationProblem(
      "The toolConfig field must be defined when using toolUse and toolResult content blocks.",
    )
  }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i] as NormalMessage
    if (message.role === "user" && message.hasDocument && message.text.length === 0) {
      throw new ValidationProblem(
        `The model returned the following errors: messages.${i}: A text block must be included alongside a document block.`,
      )
    }
    if (message.role !== "assistant" || message.toolUses.length === 0) continue
    const next = messages[i + 1]
    if (!next) continue
    const missing = message.toolUses.filter((use) => !next.toolResultIds.includes(use.id))
    if (missing.length > 0) {
      throw new ValidationProblem(
        `Expected toolResult blocks at messages.${i + 1}.content for the following Ids: ${missing.map((m) => m.id).join(", ")}`,
      )
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i] as NormalMessage
    if (message.toolResultIds.length === 0) continue
    const previous = messages[i - 1]
    const known = new Set(previous?.toolUses.map((use) => use.id) ?? [])
    const orphan = message.toolResultIds.find((id) => !known.has(id))
    if (orphan !== undefined) {
      throw new ValidationProblem(
        `messages.${i}.content: unexpected tool_use_id found in tool_result blocks: ${orphan}. Each tool_result block must have a corresponding tool_use block in the previous message.`,
      )
    }
  }
  if (messages.at(-1)?.role === "assistant" && NO_PREFILL.test(modelId)) {
    throw new ValidationProblem(
      "This model does not support assistant message prefill. The conversation must end with a user message.",
    )
  }
}

const converseMessage = (value: unknown, index: number): NormalMessage => {
  if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant")) {
    throw new ValidationProblem(`messages.${index}.role: must be one of [user, assistant]`)
  }
  const content = array(value.content)
  if (content.length === 0) {
    throw new ValidationProblem(
      `messages.${index}.content: The content field in the Message object at messages.${index} is empty. Add a ContentBlock object to the content field and try again.`,
    )
  }
  const out: NormalMessage = {
    role: value.role,
    text: textOf(content),
    toolUses: [],
    toolResultIds: [],
    hasContent: false,
    hasDocument: false,
    hasImage: false,
    hasCachePoint: false,
    chars: 0,
  }
  for (const [at, block] of content.entries()) {
    if (!isRecord(block)) continue
    out.chars += JSON.stringify(block).length
    if (typeof block.text === "string") out.hasContent = true
    if (isRecord(block.document)) {
      const name = block.document.name
      if (typeof name === "string" && (!DOCUMENT_NAME.test(name) || /\s{2,}/.test(name))) {
        throw new ValidationProblem(DOCUMENT_NAME_MESSAGE)
      }
      out.hasDocument = true
      out.hasContent = true
    }
    if (isRecord(block.image)) {
      out.hasImage = true
      out.hasContent = true
    }
    if (isRecord(block.video)) out.hasContent = true
    if (isRecord(block.cachePoint)) {
      if (isRecord(content[at - 1]) && isRecord((content[at - 1] as Json).document)) {
        throw new ValidationProblem(
          `The model returned the following errors: messages.${index}.content.${at}: a cachePoint cannot directly follow a document block.`,
        )
      }
      out.hasCachePoint = true
    }
    if (isRecord(block.toolUse)) {
      out.toolUses.push({
        id: String(block.toolUse.toolUseId ?? ""),
        name: String(block.toolUse.name ?? ""),
      })
    }
    if (isRecord(block.toolResult)) out.toolResultIds.push(String(block.toolResult.toolUseId ?? ""))
  }
  return out
}

/** Analyse (and validate) a Converse / ConverseStream body. */
export const analyzeConverse = (
  operation: ModelOperation,
  modelId: string,
  body: unknown,
  options: { validatePromptCaching?: boolean } = {},
): CallAnalysis => {
  if (!isRecord(body))
    throw new ValidationProblem(
      "Malformed input request, please reformat your input and try again.",
    )
  const messages = array(body.messages).map(converseMessage)
  const system = array(body.system)
  const toolConfig = isRecord(body.toolConfig) ? body.toolConfig : undefined
  const toolSchemas: Record<string, unknown> = {}
  for (const tool of array(toolConfig?.tools)) {
    if (!isRecord(tool) || !isRecord(tool.toolSpec)) continue
    const spec = tool.toolSpec
    const schema = isRecord(spec.inputSchema) ? spec.inputSchema.json : undefined
    toolSchemas[String(spec.name)] = parseSchema(schema) ?? {}
  }
  const tools = Object.keys(toolSchemas)
  const choice = isRecord(toolConfig?.toolChoice) ? toolConfig.toolChoice : undefined
  let toolChoice: string | undefined
  if (choice) {
    if (isRecord(choice.tool)) toolChoice = `tool:${String(choice.tool.name)}`
    else if (choice.any !== undefined) toolChoice = "any"
    else if (choice.auto !== undefined) toolChoice = "auto"
  }
  if (toolConfig && tools.length === 0) {
    throw new ValidationProblem(
      "The value at toolConfig.tools failed to satisfy constraint: Member must have length greater than or equal to 1",
    )
  }
  if (toolChoice?.startsWith("tool:") && !tools.includes(toolChoice.slice(5))) {
    throw new ValidationProblem(
      `The provided toolChoice ${toolChoice.slice(5)} is not a tool in toolConfig.tools.`,
    )
  }
  const inference = isRecord(body.inferenceConfig) ? body.inferenceConfig : {}
  const additional = isRecord(body.additionalModelRequestFields)
    ? body.additionalModelRequestFields
    : {}
  const hasTemperature = inference.temperature !== undefined || additional.temperature !== undefined
  const hasTopP = inference.topP !== undefined || additional.top_p !== undefined
  if (hasTemperature && hasTopP && ONE_SAMPLING_PARAM.test(modelId)) {
    throw new ValidationProblem(
      "The model returned the following errors: `temperature` and `top_p` cannot both be specified for this model. Please use only one.",
    )
  }
  checkConversation(messages, modelId, toolConfig !== undefined)

  let structured: StructuredRequest | undefined
  const outputConfig = isRecord(body.outputConfig) ? body.outputConfig : undefined
  const textFormat = isRecord(outputConfig?.textFormat) ? outputConfig.textFormat : undefined
  const jsonSchema =
    textFormat && isRecord(textFormat.structure) && isRecord(textFormat.structure.jsonSchema)
      ? textFormat.structure.jsonSchema
      : undefined
  const nativeFormat =
    isRecord(additional.output_config) && isRecord(additional.output_config.format)
      ? additional.output_config.format
      : undefined
  if (jsonSchema) {
    let schema: unknown = jsonSchema.schema
    if (typeof schema === "string") {
      try {
        schema = JSON.parse(schema) as unknown
      } catch {
        schema = undefined
      }
      if (!isRecord(schema)) {
        throw new ValidationProblem("The structured output schema is not a valid JSON object.")
      }
    }
    const reason = unsupportedSchemaReason(schema)
    if (reason) throw new ValidationProblem(reason)
    structured = {
      form: "outputConfig",
      schema,
      ...(typeof jsonSchema.name === "string" ? { name: jsonSchema.name } : {}),
    }
  } else if (nativeFormat && nativeFormat.type === "json_schema") {
    structured = { form: "outputFormat", schema: parseSchema(nativeFormat.schema) }
  } else if (toolChoice?.startsWith("tool:")) {
    const tool = toolChoice.slice(5)
    structured = { form: "tool", tool, schema: toolSchemas[tool] }
  } else if (toolChoice === "any" && tools.length > 0) {
    const tool = tools.includes("json") ? "json" : (tools[0] as string)
    structured = { form: "tool", tool, schema: toolSchemas[tool] }
  }

  const facts = conversationFacts(messages)
  const systemText = textOf(system)
  const hasCachePoint =
    messages.some((m) => m.hasCachePoint) ||
    system.some((b) => isRecord(b) && isRecord(b.cachePoint)) ||
    array(toolConfig?.tools).some((t) => isRecord(t) && isRecord(t.cachePoint))
  if (hasCachePoint && options.validatePromptCaching !== false && !PROMPT_CACHING.test(modelId)) {
    throw new ValidationProblem(
      "The model does not support prompt caching: remove the cachePoint block from the request.",
    )
  }
  return {
    operation,
    modelId,
    lastUserText: facts.lastUserText,
    systemText,
    tools,
    toolSchemas,
    toolChoice,
    hasDocument: messages.some((m) => m.hasDocument),
    hasImage: messages.some((m) => m.hasImage),
    hasCachePoint,
    hasGuardrail: isRecord(body.guardrailConfig),
    toolResults: facts.toolResults,
    turnIndex: facts.turnIndex,
    structured,
    inputChars:
      messages.reduce((sum, m) => sum + m.chars, 0) +
      systemText.length +
      JSON.stringify(toolSchemas).length,
  }
}

const anthropicMessage = (value: unknown, index: number): NormalMessage => {
  if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant")) {
    throw new ValidationProblem(`messages.${index}.role: Input should be 'user' or 'assistant'`)
  }
  const blocks =
    typeof value.content === "string"
      ? [{ type: "text", text: value.content }]
      : array(value.content)
  if (blocks.length === 0)
    throw new ValidationProblem(`messages.${index}: all messages must have non-empty content`)
  const out: NormalMessage = {
    role: value.role,
    text: textOf(blocks.filter((b) => isRecord(b) && b.type === "text")),
    toolUses: [],
    toolResultIds: [],
    hasContent: false,
    hasDocument: false,
    hasImage: false,
    hasCachePoint: false,
    chars: 0,
  }
  for (const block of blocks) {
    if (!isRecord(block)) continue
    out.chars += JSON.stringify(block).length
    if (isRecord(block.cache_control)) out.hasCachePoint = true
    switch (block.type) {
      case "text":
        out.hasContent = true
        break
      case "document":
        out.hasDocument = true
        out.hasContent = true
        break
      case "image":
        out.hasImage = true
        out.hasContent = true
        break
      case "tool_use":
        out.toolUses.push({ id: String(block.id ?? ""), name: String(block.name ?? "") })
        break
      case "tool_result":
        out.toolResultIds.push(String(block.tool_use_id ?? ""))
        break
    }
  }
  return out
}

/** Analyse (and validate) an Anthropic Messages body sent through InvokeModel. */
export const analyzeAnthropic = (modelId: string, body: unknown): CallAnalysis => {
  if (!isRecord(body))
    throw new ValidationProblem(
      "Malformed input request, please reformat your input and try again.",
    )
  if (typeof body.anthropic_version !== "string") {
    throw new ValidationProblem(
      "Malformed input request: #: required key [anthropic_version] not found, please reformat your input and try again.",
    )
  }
  if (typeof body.max_tokens !== "number") {
    throw new ValidationProblem(
      "Malformed input request: #: required key [max_tokens] not found, please reformat your input and try again.",
    )
  }
  if (
    body.temperature !== undefined &&
    body.top_p !== undefined &&
    ONE_SAMPLING_PARAM.test(modelId)
  ) {
    throw new ValidationProblem(
      "`temperature` and `top_p` cannot both be specified for this model. Please use only one.",
    )
  }
  const messages = array(body.messages).map(anthropicMessage)
  const toolSchemas: Record<string, unknown> = {}
  for (const tool of array(body.tools)) {
    if (isRecord(tool) && typeof tool.name === "string")
      toolSchemas[tool.name] = tool.input_schema ?? {}
  }
  checkConversation(messages, modelId, true)
  const system = typeof body.system === "string" ? body.system : textOf(array(body.system))
  const choice = isRecord(body.tool_choice) ? body.tool_choice : undefined
  const toolChoice =
    choice?.type === "tool"
      ? `tool:${String(choice.name)}`
      : typeof choice?.type === "string"
        ? choice.type
        : undefined
  const tools = Object.keys(toolSchemas)
  let structured: StructuredRequest | undefined
  const format =
    isRecord(body.output_config) && isRecord(body.output_config.format)
      ? body.output_config.format
      : undefined
  if (format?.type === "json_schema") structured = { form: "outputFormat", schema: format.schema }
  else if (toolChoice?.startsWith("tool:")) {
    const tool = toolChoice.slice(5)
    structured = { form: "tool", tool, schema: toolSchemas[tool] }
  }
  const facts = conversationFacts(messages)
  return {
    operation: "InvokeModel",
    modelId,
    lastUserText: facts.lastUserText,
    systemText: system,
    tools,
    toolSchemas,
    toolChoice,
    hasDocument: messages.some((m) => m.hasDocument),
    hasImage: messages.some((m) => m.hasImage),
    hasCachePoint: messages.some((m) => m.hasCachePoint),
    hasGuardrail: false,
    toolResults: facts.toolResults,
    turnIndex: facts.turnIndex,
    structured,
    inputChars: messages.reduce((sum, m) => sum + m.chars, 0) + system.length,
  }
}

/** Analyse an AgentCore InvokeHarness body. */
export const analyzeHarness = (harnessArn: string, body: unknown): CallAnalysis => {
  if (!isRecord(body) || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ValidationProblem(
      "1 validation error detected: Value null at 'messages' failed to satisfy constraint: Member must not be null",
    )
  }
  const messages = array(body.messages).map(converseMessage)
  const facts = conversationFacts(messages)
  const system =
    typeof body.systemPrompt === "string" ? body.systemPrompt : textOf(array(body.systemPrompt))
  return {
    operation: "InvokeHarness",
    modelId: harnessArn,
    lastUserText: facts.lastUserText,
    systemText: system,
    tools: array(body.tools)
      .map((tool) => (isRecord(tool) && typeof tool.name === "string" ? tool.name : undefined))
      .filter((name): name is string => name !== undefined),
    toolSchemas: {},
    toolChoice: undefined,
    hasDocument: false,
    hasImage: false,
    hasCachePoint: false,
    hasGuardrail: false,
    toolResults: facts.toolResults,
    turnIndex: facts.turnIndex,
    structured: undefined,
    inputChars: messages.reduce((sum, m) => sum + m.chars, 0) + system.length,
  }
}
