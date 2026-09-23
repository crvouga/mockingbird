/**
 * Plans on the wire: the Converse JSON body, the ConverseStream event frames, the
 * Anthropic Messages body InvokeModel returns, and the AgentCore harness event frames.
 * Streams pace themselves on the mock clock (`delayMsPerChunk`) and carry the mid-stream
 * faults: an exception frame after N chunks, or a frame cut off half-way.
 */
import { eventFrame, exceptionFrame } from "./eventstream.js"
import { chunk, type Plan, type PlanBlock } from "./plan.js"
import type { TurnFault } from "./scripts.js"

/** Waits `ms` on the mock clock; resolves early when `signal` aborts. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

const REASONING_SIGNATURE = "mock-reasoning-signature"

/** Converse / ConverseStream content block for a plan block. */
const converseBlock = (block: PlanBlock): Record<string, unknown> | undefined => {
  switch (block.kind) {
    case "text":
      return { text: block.text }
    case "reasoning":
      return {
        reasoningContent: { reasoningText: { text: block.text, signature: REASONING_SIGNATURE } },
      }
    case "toolUse":
      return { toolUse: { toolUseId: block.toolUseId, name: block.name, input: block.input } }
    case "toolResult":
      return undefined
  }
}

/** The Converse response body. */
export const converseBody = (plan: Plan, latencyMs: number): Record<string, unknown> => ({
  output: {
    message: {
      role: "assistant",
      content: plan.blocks.map(converseBlock).filter((b) => b !== undefined),
    },
  },
  stopReason: plan.stopReason,
  usage: plan.usage,
  metrics: { latencyMs },
  ...(plan.trace ? { trace: plan.trace } : {}),
})

/** The Anthropic Messages body InvokeModel returns for a Claude model. */
export const anthropicBody = (
  plan: Plan,
  modelId: string,
  id: string,
): Record<string, unknown> => ({
  id,
  type: "message",
  role: "assistant",
  model: modelId,
  content: plan.blocks
    .map((block) => {
      switch (block.kind) {
        case "text":
          return { type: "text", text: block.text }
        case "reasoning":
          return { type: "thinking", thinking: block.text, signature: REASONING_SIGNATURE }
        case "toolUse":
          return { type: "tool_use", id: block.toolUseId, name: block.name, input: block.input }
        default:
          return undefined
      }
    })
    .filter((b) => b !== undefined),
  stop_reason: plan.stopReason === "guardrail_intervened" ? "refusal" : plan.stopReason,
  stop_sequence: null,
  usage: {
    input_tokens: plan.usage.inputTokens,
    output_tokens: plan.usage.outputTokens,
    ...(plan.usage.cacheReadInputTokens !== undefined
      ? { cache_read_input_tokens: plan.usage.cacheReadInputTokens }
      : {}),
    ...(plan.usage.cacheWriteInputTokens !== undefined
      ? { cache_creation_input_tokens: plan.usage.cacheWriteInputTokens }
      : {}),
  },
})

/** One streamed unit: either a frame, or a content delta the pacing and faults count. */
type Step = { frame: Uint8Array; content: boolean }

const MESSAGES: Record<string, string> = {
  modelStreamErrorException: "The model stream encountered an error. Try your request again.",
  internalServerException:
    "The system encountered an unexpected error during processing. Try your request again.",
  throttlingException: "Too many requests, please wait before trying again.",
  validationException: "The input fails to satisfy the constraints specified by the service.",
  serviceUnavailableException: "Bedrock is unable to process your request.",
  runtimeClientError: "The harness runtime failed while processing the request.",
}

/**
 * Turn frames into a response body: waits `delayMsPerChunk` on the mock clock before each
 * content delta, and applies a mid-stream fault once `afterChunks` deltas went out.
 */
export const paced = (
  steps: Step[],
  options: {
    sleep: Sleep
    delayMsPerChunk: number
    fault: TurnFault | undefined
    defaultException: string
    signal?: AbortSignal
  },
): ReadableStream<Uint8Array> => {
  const fault =
    options.fault?.type === "mid_stream_exception" || options.fault?.type === "truncated_frame"
      ? options.fault
      : undefined
  const after = fault?.afterChunks ?? 1
  let index = 0
  let sent = 0
  let done = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return
      const step = steps[index]
      if (fault && sent >= after && (step === undefined || step.content)) {
        done = true
        if (fault.type === "mid_stream_exception") {
          const type = fault.exceptionType ?? options.defaultException
          controller.enqueue(
            exceptionFrame(type, { message: fault.message ?? MESSAGES[type] ?? "Stream failure." }),
          )
        } else {
          const next = step?.frame ?? steps.at(-1)?.frame ?? new Uint8Array(16)
          controller.enqueue(next.subarray(0, Math.max(1, Math.floor(next.length / 2))))
        }
        controller.close()
        return
      }
      if (step === undefined) {
        done = true
        controller.close()
        return
      }
      if (step.content && options.delayMsPerChunk > 0) {
        await options.sleep(options.delayMsPerChunk, options.signal)
      }
      if (options.signal?.aborted) {
        done = true
        controller.close()
        return
      }
      controller.enqueue(step.frame)
      if (step.content) sent++
      index++
    },
  })
}

/** Every ConverseStream frame for a plan, in the order Bedrock sends them. */
export const converseStreamSteps = (plan: Plan, latencyMs: number): Step[] => {
  const steps: Step[] = [
    { frame: eventFrame("messageStart", { role: "assistant" }), content: false },
  ]
  plan.blocks
    .filter((block) => block.kind !== "toolResult")
    .forEach((block, contentBlockIndex) => {
      if (block.kind === "toolUse") {
        steps.push({
          frame: eventFrame("contentBlockStart", {
            contentBlockIndex,
            start: { toolUse: { toolUseId: block.toolUseId, name: block.name } },
          }),
          content: false,
        })
        for (const part of chunk(JSON.stringify(block.input ?? {}), Math.max(plan.chunkSize, 8))) {
          steps.push({
            frame: eventFrame("contentBlockDelta", {
              contentBlockIndex,
              delta: { toolUse: { input: part } },
            }),
            content: true,
          })
        }
      } else if (block.kind === "reasoning") {
        for (const part of chunk(block.text, plan.chunkSize)) {
          steps.push({
            frame: eventFrame("contentBlockDelta", {
              contentBlockIndex,
              delta: { reasoningContent: { text: part } },
            }),
            content: true,
          })
        }
        steps.push({
          frame: eventFrame("contentBlockDelta", {
            contentBlockIndex,
            delta: { reasoningContent: { signature: REASONING_SIGNATURE } },
          }),
          content: false,
        })
      } else if (block.kind === "text") {
        for (const part of chunk(block.text, plan.chunkSize)) {
          steps.push({
            frame: eventFrame("contentBlockDelta", { contentBlockIndex, delta: { text: part } }),
            content: true,
          })
        }
      }
      steps.push({ frame: eventFrame("contentBlockStop", { contentBlockIndex }), content: false })
    })
  steps.push({ frame: eventFrame("messageStop", { stopReason: plan.stopReason }), content: false })
  steps.push({
    frame: eventFrame("metadata", {
      usage: plan.usage,
      metrics: { latencyMs },
      ...(plan.trace ? { trace: plan.trace } : {}),
    }),
    content: false,
  })
  return steps
}

/** Every InvokeHarness frame for a plan (AgentCore's harness stream). */
export const harnessSteps = (plan: Plan, latencyMs: number): Step[] => {
  const steps: Step[] = [
    { frame: eventFrame("messageStart", { role: "assistant" }), content: false },
  ]
  plan.blocks.forEach((block, contentBlockIndex) => {
    if (block.kind === "toolUse") {
      steps.push({
        frame: eventFrame("contentBlockStart", {
          contentBlockIndex,
          start: { toolUse: { toolUseId: block.toolUseId, name: block.name } },
        }),
        content: false,
      })
      steps.push({
        frame: eventFrame("contentBlockDelta", {
          contentBlockIndex,
          delta: { toolUse: { input: JSON.stringify(block.input ?? {}) } },
        }),
        content: true,
      })
    } else if (block.kind === "toolResult") {
      steps.push({
        frame: eventFrame("contentBlockStart", {
          contentBlockIndex,
          start: { toolResult: { toolUseId: block.toolUseId, status: "success" } },
        }),
        content: false,
      })
      steps.push({
        frame: eventFrame("contentBlockDelta", {
          contentBlockIndex,
          delta: { toolResult: block.content },
        }),
        content: true,
      })
    } else {
      for (const part of chunk(block.text, plan.chunkSize)) {
        steps.push({
          frame: eventFrame("contentBlockDelta", {
            contentBlockIndex,
            delta:
              block.kind === "reasoning" ? { reasoningContent: { text: part } } : { text: part },
          }),
          content: true,
        })
      }
    }
    steps.push({ frame: eventFrame("contentBlockStop", { contentBlockIndex }), content: false })
  })
  steps.push({ frame: eventFrame("messageStop", { stopReason: plan.stopReason }), content: false })
  steps.push({
    frame: eventFrame("metadata", {
      usage: {
        inputTokens: plan.usage.inputTokens,
        outputTokens: plan.usage.outputTokens,
        totalTokens: plan.usage.totalTokens,
      },
      metrics: { latencyMs },
    }),
    content: false,
  })
  return steps
}
