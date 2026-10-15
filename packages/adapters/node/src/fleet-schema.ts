import schema from "./fleet-config.schema.json" with { type: "json" }
import type { CliOption, MockingbirdConfig } from "./cli.js"

export const fleetConfigSchema = schema
export type ConfigIssue = { path: string; message: string }
type Schema = { $ref?: string; type?: string; const?: unknown; enum?: unknown[]; anyOf?: Schema[]; required?: string[]; properties?: Record<string, Schema>; additionalProperties?: boolean | Schema; items?: Schema; propertyNames?: Schema; pattern?: string; minimum?: number; maximum?: number; $defs?: Record<string, Schema> }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)
/** Standalone validation uses exactly the published schema; composing targets admits only declared flags. */
export function validateFleetConfig(value: unknown, targetOptions: Record<string, Record<string, CliOption>> = {}, extensions: Record<string, Schema> = {}): ConfigIssue[] {
  const composed = composeFleetSchema(value, targetOptions, extensions) as Schema, issues: ConfigIssue[] = []
  const walk = (input: unknown, rule: Schema, path: string, output: ConfigIssue[]) => {
    if (rule.$ref) { const resolved = composed.$defs?.[rule.$ref.slice("#/$defs/".length)]; if (!resolved) output.push({ path, message: "unresolved configuration schema" }); else walk(input, resolved, path, output); return }
    if (rule.anyOf) { if (!rule.anyOf.some((branch) => { const found: ConfigIssue[] = []; walk(input, branch, path, found); return found.length === 0 })) output.push({ path, message: "value does not match an allowed shape" }); return }
    if ("const" in rule && input !== rule.const) { output.push({ path, message: path === "$.schemaVersion" || path === "$.$schema" ? "unsupported fleet schema version; upgrade the consumer/schema together" : "unexpected fixed value" }); return }
    if (rule.enum && !rule.enum.includes(input)) output.push({ path, message: "unsupported enumerated value" })
    if (rule.type) {
      const valid = rule.type === "object" ? object(input) : rule.type === "array" ? Array.isArray(input) : rule.type === "integer" ? typeof input === "number" && Number.isInteger(input) : typeof input === rule.type
      if (!valid) { output.push({ path, message: `expected ${rule.type}` }); return }
    }
    if (typeof input === "number" && (rule.minimum !== undefined && input < rule.minimum || rule.maximum !== undefined && input > rule.maximum)) output.push({ path, message: "number outside supported bounds" })
    if (typeof input === "string" && rule.pattern && !new RegExp(rule.pattern).test(input)) output.push({ path, message: "invalid identifier" })
    if (Array.isArray(input) && rule.items) input.forEach((entry, index) => walk(entry, rule.items as Schema, `${path}[${index}]`, output))
    if (object(input)) {
      for (const name of rule.required ?? []) if (!Object.hasOwn(input, name)) output.push({ path: `${path}.${name}`, message: "required field missing" })
      for (const [key, entry] of Object.entries(input)) {
        if (rule.propertyNames) walk(key, rule.propertyNames, `${path}.${key}`, output)
        const property = rule.properties?.[key]
        if (property) walk(entry, property, `${path}.${key}`, output)
        else if (rule.additionalProperties === false) output.push({ path: `${path}.${key}`, message: "unknown configuration field" })
        else if (object(rule.additionalProperties)) walk(entry, rule.additionalProperties, `${path}.${key}`, output)
      }
    }
  }
  walk(value, composed, "$", issues)
  return issues
}
export function composeFleetSchema(value: unknown, targetOptions: Record<string, Record<string, CliOption>> = {}, extensions: Record<string, Schema> = {}) {
  const composed = structuredClone(schema) as unknown as Schema
  const serviceRule = composed.$defs?.service as Schema
  const servicesRule = composed.properties?.services as Schema
  servicesRule.properties = {}
  if (object(value) && object(value.services)) for (const [instance, entry] of Object.entries(value.services)) {
    if (!object(entry)) continue
    const target = typeof entry.target === "string" ? entry.target : instance
    const declared = targetOptions[target] ?? {}
    const configured = structuredClone(serviceRule)
    configured.properties = { ...configured.properties, options: { type: "object", additionalProperties: false, properties: Object.fromEntries(Object.entries(declared).map(([key, option]) => [key, { type: option.type }])) } }
    servicesRule.properties[instance] = configured
  }
  if (composed.properties?.extensions) composed.properties.extensions.properties = extensions
  return composed
}
export function assertFleetConfig(config: MockingbirdConfig, targetOptions: Record<string, Record<string, CliOption>> = {}) {
  const issues = validateFleetConfig(config, targetOptions)
  if (issues.length) throw new Error(issues.slice(0, 20).map((i) => `${i.path}: ${i.message}`).join("; "))
}
