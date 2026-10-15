import { Collection } from "@crvouga/mockingbird-service"
import {
  type BackgroundJobInteraction,
  getExtensionValue,
  resourceMatchesSubscriptionCriteria,
  stringify,
} from "@medplum/core"
import type { Resource, Subscription } from "@medplum/fhirtypes"
import type { FhirStore } from "./store.js"

type Delivery = {
  subscription: Subscription
  resource: Resource
  interaction: BackgroundJobInteraction
}

/** A transactional outbox: rolled-back FHIR versions never reach an external endpoint. */
export class RestHookSubscriptions {
  private readonly outbox: Collection<Delivery>

  constructor(private readonly store: FhirStore) {
    this.outbox = new Collection(store.sqlite, store.namespace, "medplum:rest-hooks")
  }

  async enqueue(
    resource: Resource,
    previous: Resource | undefined,
    interaction: BackgroundJobInteraction,
  ): Promise<void> {
    if (resource.resourceType === "AuditEvent") return
    const projectId = resource.meta?.project
    for (const row of this.store
      .rows("Subscription")
      .filter(
        (row) =>
          !row.deleted &&
          row.projectId === projectId &&
          (row.content as Subscription | undefined)?.status === "active",
      )
      .slice(0, 1000)) {
      const subscription = row.content as Subscription
      if (
        subscription.status !== "active" ||
        subscription.channel?.type !== "rest-hook" ||
        !subscription.channel.endpoint
      )
        continue
      let matches = false
      try {
        matches = await resourceMatchesSubscriptionCriteria({
          resource,
          subscription,
          context: { interaction },
          getPreviousResource: async () => previous,
        })
      } catch {
        // A malformed criterion on an unrelated subscription must not fail a FHIR write.
      }
      if (!matches) continue
      const id = `${subscription.id}/${resource.resourceType}/${resource.id}/${resource.meta?.versionId}`
      this.outbox.insert(id, { subscription, resource, interaction })
    }
  }

  /** Claim committed deliveries before network I/O, allowing hooks to call back into the API. */
  take(): Delivery[] {
    const deliveries = this.outbox.list({ order: "oldest" })
    for (const delivery of deliveries) this.outbox.delete(delivery.id)
    return deliveries.map((delivery) => delivery.value)
  }

  async deliver(deliveries: Delivery[]): Promise<void> {
    await Promise.all(
      deliveries.map(async ({ subscription, resource, interaction }) => {
        try {
          const body = interaction === "delete" ? "{}" : stringify(resource)
          const headers = new Headers({
            "Content-Type": "application/fhir+json",
            "X-Medplum-Subscription": subscription.id as string,
            "X-Medplum-Interaction": interaction,
          })
          if (interaction === "delete")
            headers.set("X-Medplum-Deleted-Resource", `${resource.resourceType}/${resource.id}`)
          for (const header of subscription.channel.header ?? []) {
            const colon = header.indexOf(":")
            if (colon > 0)
              headers.set(header.slice(0, colon).trim(), header.slice(colon + 1).trim())
          }
          const secret =
            getExtensionValue(
              subscription,
              "https://www.medplum.com/fhir/StructureDefinition/subscription-secret",
            ) ||
            getExtensionValue(
              subscription,
              "https://www.medplum.com/fhir/StructureDefinition-subscriptionSecret",
            )
          if (typeof secret === "string" && secret) {
            const key = await crypto.subtle.importKey(
              "raw",
              new TextEncoder().encode(secret),
              { name: "HMAC", hash: "SHA-256" },
              false,
              ["sign"],
            )
            const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
            headers.set(
              "X-Signature",
              Array.from(new Uint8Array(signature), (byte) =>
                byte.toString(16).padStart(2, "0"),
              ).join(""),
            )
          }
          const response = await fetch(subscription.channel.endpoint as string, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(10000),
          })
          await response.body?.cancel()
        } catch {
          // Hook failures are isolated from the committed write and other subscribers.
        }
      }),
    )
  }
}
