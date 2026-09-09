import type { OpenAPIDocument } from "@crvouga/mockingbird-openapi"
import fc from "fast-check"
import {
  type CommandArbitraryOptions,
  describeCommand,
  isEligible,
  type LogicalCommand,
  planCommandArbitrary,
} from "./command.js"
import {
  createExploreRng,
  type DynamicWeightFn,
  defaultDynamicWeight,
  type ExploreState,
  pickWeightedIndex,
  pushHistory,
  resourceCountsFrom,
  resourceTypesOf,
  weightPlans,
} from "./explore.js"
import type { OperationPlan } from "./plan.js"

export type GuidedSampleOptions = Omit<CommandArbitraryOptions, "document" | "plans" | "weights"> & {
  document: OpenAPIDocument
  plans: readonly OperationPlan[]
  weightFn?: DynamicWeightFn
  /** Max plan/command retries when the sampled command is ineligible. Default 24. */
  maxAttempts?: number
  /**
   * Rewrite a sampled command before eligibility (e.g. pin zip_code to a sealed observation
   * corpus so area/psc GETs hit the seed cache).
   */
  reshapeCommand?: (
    command: LogicalCommand,
    state: ExploreState,
    rng: ReturnType<typeof createExploreRng>,
  ) => LogicalCommand
}

/**
 * Sample one eligible {@link LogicalCommand} using dynamic weights over the current explore state.
 * Returns undefined when no plan has positive weight or every attempt is ineligible.
 */
export const sampleGuidedCommand = (
  state: ExploreState,
  options: GuidedSampleOptions,
  rng: ReturnType<typeof createExploreRng>,
): LogicalCommand | undefined => {
  const weightFn = options.weightFn ?? defaultDynamicWeight
  const maxAttempts = options.maxAttempts ?? 24
  const commandOptions: CommandArbitraryOptions = {
    document: options.document,
    plans: options.plans,
    ...(options.invalidProbability === undefined
      ? {}
      : { invalidProbability: options.invalidProbability }),
    ...(options.missingProbability === undefined
      ? {}
      : { missingProbability: options.missingProbability }),
    ...(options.optionalProbability === undefined
      ? {}
      : { optionalProbability: options.optionalProbability }),
    ...(options.bodyProbability === undefined
      ? {}
      : { bodyProbability: options.bodyProbability }),
    ...(options.coverageBias === undefined ? {} : { coverageBias: options.coverageBias }),
    ...(options.coverage === undefined ? {} : { coverage: options.coverage }),
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const weighted = weightPlans(options.plans, state, weightFn)
    if (weighted.length === 0) return undefined
    const plan = weighted[pickWeightedIndex(weighted, rng.next())]?.plan
    if (!plan) return undefined
    const sampleSeed = rng.nextInt(0x7fffffff)
    const [sampled] = fc.sample(planCommandArbitrary(plan, commandOptions), {
      seed: sampleSeed,
      numRuns: 1,
    })
    if (!sampled) continue
    const command = options.reshapeCommand
      ? options.reshapeCommand(sampled, state, rng)
      : sampled
    if (!isEligible(command, (type) => state.resourceCounts[type] ?? 0)) continue
    return command
  }
  return undefined
}

export type GuidedWalkHooks = {
  /** Called after each accepted command is recorded into explore state (before next sample). */
  afterCommand?: (command: LogicalCommand, state: ExploreState) => void
  /** Live resource counts; defaults to the explore state's cached counts when omitted. */
  count?: (type: string) => number
}

/**
 * Build a walk of up to `steps` commands, re-weighting after every acceptance.
 * Does not execute HTTP — callers run the commands and feed updated `count` via hooks /
 * by mutating resource counts between samples when using {@link runGuidedWalk}.
 */
export const generateGuidedWalk = (
  options: GuidedSampleOptions & {
    steps: number
    seed: number
    phase: ExploreState["phase"]
    observationCacheSize?: number
  },
  hooks: GuidedWalkHooks = {},
): LogicalCommand[] => {
  const rng = createExploreRng(options.seed)
  const types = resourceTypesOf(options.plans)
  const coverage: Record<string, number> = { ...(options.coverage ?? {}) }
  const history: string[] = []
  const commands: LogicalCommand[] = []

  for (let step = 0; step < options.steps; step += 1) {
    const resourceCounts = hooks.count
      ? resourceCountsFrom(hooks.count, types)
      : resourceCountsFrom(() => 0, types)
    const state: ExploreState = {
      coverage,
      history,
      resourceCounts,
      phase: options.phase,
      step,
      maxSteps: options.steps,
      ...(options.observationCacheSize === undefined
        ? {}
        : { observationCacheSize: options.observationCacheSize }),
    }
    const command = sampleGuidedCommand(state, { ...options, coverage }, rng)
    if (!command) break
    commands.push(command)
    coverage[command.operationId] = (coverage[command.operationId] ?? 0) + 1
    pushHistory(history, command.operationId)
    hooks.afterCommand?.(command, {
      ...state,
      coverage: { ...coverage },
      history: [...history],
      resourceCounts: hooks.count
        ? resourceCountsFrom(hooks.count, types)
        : state.resourceCounts,
      step: step + 1,
    })
  }
  return commands
}

export { describeCommand }
