import { toBase64, type WebhookSigner } from "@crvouga/mockingbird-service"
import type { OrderRecord, StatusSummary, TrackingRecord } from "./types.js"

export const PUSH_EVENT = "order.status.changed"

export const PUSH_SHAPE_HEADER = "x-mockingbird-push-shape"

export const PROVISIONAL_PUSH_SHAPE = "provisional-2026-11"

export const PUSH_RETRY_DELAYS_MS = [0, 5_000, 30_000] as const

export type PushBody = {
  event: typeof PUSH_EVENT
  orderId: number
  referenceId: string | null
  status: StatusSummary
  previousStatus: StatusSummary | null
  changedOn: string
  rxs: { uuid: string; rxNumber: string | null; fillId: number | null }[]
  shipping?: TrackingRecord
}

export const pushBody = (input: {
  order: OrderRecord
  status: StatusSummary
  previous: StatusSummary | null
  changedOn: string
  tracking: TrackingRecord | null
}): PushBody => ({
  event: PUSH_EVENT,
  orderId: input.order.id,
  referenceId: input.order.general.referenceId,
  status: input.status,
  previousStatus: input.previous,
  changedOn: input.changedOn,
  rxs: input.order.rxs.map((rx) => ({ uuid: rx.uuid, rxNumber: rx.rxNumber, fillId: rx.fillId })),
  ...(input.tracking ? { shipping: input.tracking } : {}),
})

const basic = (credentials: string) => `Basic ${toBase64(new TextEncoder().encode(credentials))}`

export const basicPushSigner =
  (): WebhookSigner =>
  ({ secret, tags }) => ({
    [PUSH_SHAPE_HEADER]: PROVISIONAL_PUSH_SHAPE,
    ...(secret
      ? { authorization: basic(tags.badCredentials === "true" ? "invalid:invalid" : secret) }
      : {}),
  })
