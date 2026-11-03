import {
  canonicalizeValue,
  formatDifference,
  structuralDiff,
} from "@crvouga/mockingbird-canonicalize"
import type { ResourceTable, Side } from "@crvouga/mockingbird-model"
import { parseOpenAPIDocument } from "@crvouga/mockingbird-openapi"

// Read only alongside a schema, and events carry none.
const noDocument = parseOpenAPIDocument({
  openapi: "3.1.0",
  info: { title: "webhooks", version: "0" },
  paths: {},
})

const canonicalEvents = (events: readonly unknown[], table: ResourceTable, side: Side) =>
  canonicalizeValue(events, {
    // Without a schema only known ids (in any string or key) become tokens.
    document: noDocument,
    schema: undefined,
    parityHeaders: [],
    side,
    table,
  }) as unknown[]

/**
 * Default webhook comparison: each side's events are canonicalized against the walk's resource
 * table like responses are, then diffed structurally (key order ignored, event order kept).
 * Returns the first difference, or `undefined` when the events agree.
 */
export const compareWebhookEvents = (
  real: readonly unknown[],
  mock: readonly unknown[],
  table: ResourceTable,
): string | undefined => {
  if (real.length !== mock.length) return `event count real=${real.length} mock=${mock.length}`
  const canonicalReal = canonicalEvents(real, table, "real")
  const canonicalMock = canonicalEvents(mock, table, "mock")
  for (let index = 0; index < canonicalReal.length; index++) {
    const [first] = structuralDiff(canonicalReal[index], canonicalMock[index])
    if (first) return `event[${index}] ${formatDifference(first)}`
  }
  return undefined
}

export const webhookEventNames = (events: readonly unknown[]) =>
  events.map((event) => {
    if (typeof event !== "object" || event === null || Array.isArray(event)) return "unknown"
    const eventType =
      (event as Record<string, unknown>).event_type ?? (event as Record<string, unknown>).type
    return typeof eventType === "string" ? eventType : "unknown"
  })
