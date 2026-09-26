import { jsonResponse, type OperationHandler, opaqueToken } from "@crvouga/mockingbird-service"
import { parameterMissing, resourceMissing } from "./errors.js"
import {
  booleanOf,
  mergeRecordMetadata,
  type RequestScope,
  requestScope,
  type Services,
  stringOf,
} from "./internal.js"
import { paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import { renderWebhookEndpoint } from "./render.js"
import { seconds, type WebhookEndpointRecord } from "./state.js"
import { validateUrl } from "./url.js"

const requireEndpoint = (scope: RequestScope, id: string): WebhookEndpointRecord => {
  const endpoint = scope.account.webhookEndpoints.get(id)
  if (!endpoint) throw resourceMissing("webhook endpoint", id, "webhook_endpoint")
  return endpoint
}

const eventsOf = (params: Params): string[] | undefined => {
  const value = params.enabled_events
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string")
  if (typeof value === "string" && value !== "") return [value]
  return undefined
}

/**
 * Webhook endpoints created through the API. They join the runtime's delivery fan-out for their
 * account (alongside `PUT /__admin/webhook-endpoints`), signed with the secret returned at
 * creation, filtered by `enabled_events`.
 */
export const webhookEndpointHandlers = (services: Services): Record<string, OperationHandler> => ({
  GetWebhookEndpoints: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    return jsonResponse(
      200,
      await paginate<WebhookEndpointRecord>(scope.account.webhookEndpoints, params, {
        url: "/v1/webhook_endpoints",
        kind: "webhook endpoint",
        where: () => true,
        render: (record) => renderWebhookEndpoint(record, false),
      }),
    )
  },
  PostWebhookEndpoints: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const url = stringOf(params, "url")
    if (url === null) throw parameterMissing("url")
    validateUrl(url, "url")
    const events = eventsOf(params)
    if (events === undefined || events.length === 0) throw parameterMissing("enabled_events")
    const id = scope.ids.next("we_", 24)
    const record: WebhookEndpointRecord = {
      id,
      api_version: stringOf(params, "api_version"),
      created: seconds(scope.now),
      description: stringOf(params, "description"),
      enabled_events: events,
      metadata: mergeRecordMetadata({}, params.metadata),
      secret: `whsec_${opaqueToken(`${id}:secret`, 32)}`,
      status: "enabled",
      url,
    }
    scope.account.webhookEndpoints.insert(id, record)
    services.endpointsChanged?.()
    return jsonResponse(200, renderWebhookEndpoint(record, true))
  },
  GetWebhookEndpointsWebhookEndpoint: async (context) => {
    const scope = requestScope(services, context)
    queryParams(context)
    return jsonResponse(
      200,
      renderWebhookEndpoint(requireEndpoint(scope, context.params.webhook_endpoint ?? ""), false),
    )
  },
  PostWebhookEndpointsWebhookEndpoint: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const current = requireEndpoint(scope, context.params.webhook_endpoint ?? "")
    const url = stringOf(params, "url")
    if (url !== null) validateUrl(url, "url")
    const disabled = booleanOf(params.disabled)
    const next: WebhookEndpointRecord = {
      ...current,
      description:
        params.description === undefined ? current.description : stringOf(params, "description"),
      enabled_events: eventsOf(params) ?? current.enabled_events,
      metadata: mergeRecordMetadata(current.metadata, params.metadata),
      status: disabled === undefined ? current.status : disabled ? "disabled" : "enabled",
      url: url ?? current.url,
    }
    scope.account.webhookEndpoints.update(next.id, next)
    services.endpointsChanged?.()
    return jsonResponse(200, renderWebhookEndpoint(next, false))
  },
  DeleteWebhookEndpointsWebhookEndpoint: async (context) => {
    const scope = requestScope(services, context)
    const endpoint = requireEndpoint(scope, context.params.webhook_endpoint ?? "")
    scope.account.webhookEndpoints.delete(endpoint.id)
    services.endpointsChanged?.()
    return jsonResponse(200, { id: endpoint.id, object: "webhook_endpoint", deleted: true })
  },
})
