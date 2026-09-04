import { FORM_MEDIA_TYPE } from "@crvouga/mockingbird-http-codec"
import {
  collectPlaceholders,
  missingPlaceholder,
  refPlaceholder,
  scopePlaceholder,
} from "@crvouga/mockingbird-model"
import type { OpenAPIDocument, ParameterObject, SchemaObject } from "@crvouga/mockingbird-openapi"
import { resolveSchema, walkSchema } from "@crvouga/mockingbird-openapi"
import {
  invalidSchemaArbitrary,
  type Mutation,
  mutationSites,
  type Override,
  schemaArbitrary,
} from "@crvouga/mockingbird-openapi-arbitrary"
import {
  parameterMetadata,
  type SchemaMetadata,
  schemaMetadata,
} from "@crvouga/mockingbird-openapi-metadata"
import fc from "fast-check"
import type { OperationPlan } from "./plan.js"

/**
 * One generated API call. Concrete ids never appear here: resource references are
 * {@link Placeholder}s resolved per side at execution time, which is what lets the same command
 * run against the real API and the mock.
 */
export type LogicalCommand = {
  operationId: string
  /** Path, query and header parameter values by name. */
  parameters: Record<string, unknown>
  body: unknown
  mediaType: string | undefined
  /** Set when the body was deliberately mutated to violate its schema. */
  invalid: Mutation | undefined
}

export type CommandArbitraryOptions = {
  document: OpenAPIDocument
  plans: readonly OperationPlan[]
  /** Chance a body is generated invalid (one violated constraint). Default 0.15. */
  invalidProbability?: number
  /** Chance a resource reference points at a well-formed but nonexistent id. Default 0.08. */
  missingProbability?: number
  /** Chance an optional parameter is present. Default 0.5. */
  optionalProbability?: number
  /** Chance an optional request body is present. Default 0.9. */
  bodyProbability?: number
}

const MAX_PICK = 1 << 16

const frequencyOf = (probability: number) =>
  Math.max(1, Math.round(1 / Math.min(Math.max(probability, 0.001), 1)))

const placeholderFor = (meta: SchemaMetadata, missingProbability: number): Override => {
  if (meta.unsupported) return "omit"
  if (meta.scope) return fc.constant(scopePlaceholder(meta.scope.value))
  const ref = meta.resourceRef ?? (meta.resource ? { type: meta.resource.type } : undefined)
  if (!ref) return undefined
  const missing = "missing" in ref ? ref.missing : undefined
  return fc.oneof(
    {
      arbitrary: fc.nat({ max: MAX_PICK }).map((pick) => refPlaceholder(ref.type, pick)),
      weight: frequencyOf(missingProbability) - 1 || 1,
    },
    { arbitrary: fc.constant(missingPlaceholder(ref.type, missing)), weight: 1 },
  )
}

/** Parameters carrying a run-scoped value anywhere in their schema are always sent: they isolate the walk. */
const carriesScope = (document: OpenAPIDocument, parameter: ParameterObject) => {
  if (parameterMetadata(document, parameter).scope) return true
  let found = false
  if (parameter.schema)
    walkSchema(document, parameter.schema, (node) => {
      if (schemaMetadata(node).scope) found = true
    })
  return found
}

const isSymbolic = (meta: SchemaMetadata) =>
  meta.resourceRef !== undefined ||
  meta.resource !== undefined ||
  meta.scope !== undefined ||
  meta.unsupported !== undefined

const parameterArbitrary = (
  document: OpenAPIDocument,
  parameter: ParameterObject,
  missingProbability: number,
): fc.Arbitrary<unknown> | "omit" => {
  const meta = parameterMetadata(document, parameter)
  const symbolic = placeholderFor(meta, missingProbability)
  if (symbolic !== undefined) return symbolic
  const schema: SchemaObject = parameter.schema ?? { type: "string" }
  return schemaArbitrary(schema, {
    document,
    override: (node) => placeholderFor(schemaMetadata(node), missingProbability),
  })
}

/** Arbitrary over commands for one operation. */
export const planCommandArbitrary = (
  plan: OperationPlan,
  options: CommandArbitraryOptions,
): fc.Arbitrary<LogicalCommand> => {
  const { document } = options
  const invalidProbability = options.invalidProbability ?? 0.15
  const missingProbability = options.missingProbability ?? 0.08
  const optionalProbability = options.optionalProbability ?? 0.5
  const bodyProbability = options.bodyProbability ?? 0.9

  const fields: Record<string, fc.Arbitrary<unknown>> = {}
  for (const parameter of plan.operation.parameters) {
    if (parameter.in === "cookie") continue
    const arbitrary = parameterArbitrary(document, parameter, missingProbability)
    if (arbitrary === "omit") continue
    const always =
      parameter.in === "path" || parameter.required === true || carriesScope(document, parameter)
    fields[parameter.name] = always
      ? arbitrary
      : fc.option(arbitrary, { nil: undefined, freq: frequencyOf(optionalProbability) })
  }
  const parameters = fc.record(fields).map((record) => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) if (value !== undefined) out[key] = value
    return out
  })

  const override = (node: SchemaObject) => placeholderFor(schemaMetadata(node), missingProbability)
  const formBody = plan.body?.mediaType === FORM_MEDIA_TYPE
  const skip = (node: SchemaObject, path: string[]) =>
    (formBody && path.length === 0) || isSymbolic(schemaMetadata(resolveSchema(document, node)))

  let body: fc.Arbitrary<{ value: unknown; invalid: Mutation | undefined }> = fc.constant({
    value: undefined,
    invalid: undefined,
  })
  if (plan.body) {
    const valid = schemaArbitrary(plan.body.schema, { document, override }).map((value) => ({
      value,
      invalid: undefined,
    }))
    const invalid = invalidSchemaArbitrary(plan.body.schema, { document, override, skip }).map(
      (result) => ({
        value: result.value,
        invalid: result.mutation,
      }),
    )
    const canMutate = mutationSites(document, plan.body.schema, { skip }).length > 0
    const present =
      invalidProbability > 0 && canMutate
        ? fc.oneof(
            { arbitrary: valid, weight: Math.max(1, frequencyOf(invalidProbability) - 1) },
            { arbitrary: invalid, weight: 1 },
          )
        : valid
    body = plan.body.required
      ? present
      : fc.oneof(
          { arbitrary: present, weight: Math.max(1, frequencyOf(1 - bodyProbability) - 1) },
          { arbitrary: fc.constant({ value: undefined, invalid: undefined }), weight: 1 },
        )
  }

  const mediaType = plan.body?.mediaType
  return fc.tuple(parameters, body).map(([params, generated]) => ({
    operationId: plan.operation.operationId,
    parameters: params,
    body: generated.value,
    mediaType: generated.value === undefined ? undefined : mediaType,
    invalid: generated.invalid,
  }))
}

/**
 * Arbitrary over commands for every plan. Operations that create resources without needing any
 * are weighted up so walks accumulate state early instead of skipping ineligible commands.
 */
export const commandArbitrary = (
  options: CommandArbitraryOptions,
): fc.Arbitrary<LogicalCommand> => {
  if (options.plans.length === 0) throw new RangeError("no operations to generate commands for")
  return fc.oneof(
    ...options.plans.map((plan) => ({
      arbitrary: planCommandArbitrary(plan, options),
      weight: plan.produces.length > 0 && plan.requires.length === 0 ? PRODUCER_WEIGHT : 1,
    })),
  )
}

const PRODUCER_WEIGHT = 2

/** Resource types a command references through `ref` placeholders. */
export const referencedTypes = (command: LogicalCommand): string[] => {
  const types = new Set<string>()
  for (const placeholder of collectPlaceholders([command.parameters, command.body])) {
    if (placeholder.$mockingbird === "ref") types.add(placeholder.type)
  }
  return [...types].sort()
}

/** A command may run once every referenced resource type has at least one instance. */
export const isEligible = (command: LogicalCommand, count: (type: string) => number): boolean =>
  referencedTypes(command).every((type) => count(type) > 0)

const compact = (value: unknown) => {
  const text = JSON.stringify(value, (_, v: unknown) =>
    typeof v === "object" && v !== null && "$mockingbird" in v
      ? `<${(v as { $mockingbird: string }).$mockingbird}${"type" in v ? `:${String((v as { type: unknown }).type)}` : ""}${"pick" in v ? `#${String((v as { pick: unknown }).pick)}` : ""}>`
      : v,
  )
  return text === undefined ? "" : text
}

/** Short, stable one-line description used in shrunk reproductions. */
export const describeCommand = (command: LogicalCommand): string => {
  const parts = [command.operationId]
  if (Object.keys(command.parameters).length > 0) parts.push(compact(command.parameters))
  if (command.body !== undefined) parts.push(`body=${compact(command.body)}`)
  if (command.invalid)
    parts.push(
      `invalid(${command.invalid.violation}@${command.invalid.valuePath.join("/") || "$"})`,
    )
  return parts.join(" ")
}
