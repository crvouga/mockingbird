/**
 * A port of our backend's Klaviyo client (`B/global-services/services/klaviyo/klaviyo.sevice.ts`)
 * and the queue job that drives it (`B/queues/offerings.queue.ts` `pushDataToKlaviyo`, fed by
 * `billing.service.ts` `createAnalyticsAndTrackingJobs`): the same payloads, the same headers,
 * the same `response.ok` check and error text. The acceptance tests drive the mock through it.
 */
export type Fetch = (request: Request) => Promise<Response>

/** `src/common/constants/constants.ts` KLAVIYO_EVENTS. */
export const KLAVIYO_EVENTS = Object.freeze({
  PLACE_ORDER: "Placed Order",
  ORDERED_EVENT: "Ordered Product",
})

/** `B/queues/types/klaviyo-events.type.ts` (PlacedOrder and OrderedProduct are identical). */
export type KlaviyoOrderPayload = {
  ProductId: string
  ProductName: string
  Quantity: number
  time: string
  value: number
  value_currency: string
  unique_id: string
  id: string
  email: string
  phone_number: string
}

const profile = (payload: KlaviyoOrderPayload) => ({
  data: {
    type: "profile",
    id: payload.id,
    attributes: { email: payload.email, phone_number: payload.phone_number },
  },
})

const metric = (eventType: string) => ({
  data: { type: "metric", attributes: { name: eventType } },
})

export const placedOrderEvent = (payload: KlaviyoOrderPayload, eventType: string) => ({
  data: {
    type: "event",
    attributes: {
      properties: {
        ProductId: payload.ProductId,
        ProductName: payload.ProductName,
        Quantity: payload.Quantity,
      },
      time: payload.time,
      value: payload.value,
      value_currency: payload.value_currency,
      unique_id: payload.unique_id,
      metric: metric(eventType),
      profile: profile(payload),
    },
  },
})

export const orderedProductEvent = (payload: KlaviyoOrderPayload, eventType: string) => ({
  data: {
    type: "event",
    attributes: {
      properties: {
        Items: [
          {
            ProductID: payload.ProductId,
            ProductName: payload.ProductName,
            Quantity: payload.Quantity,
            ItemPrice: payload.value,
          },
        ],
      },
      time: payload.time,
      value: payload.value,
      value_currency: payload.value_currency,
      unique_id: payload.unique_id,
      metric: metric(eventType),
      profile: profile(payload),
    },
  },
})

export class KlaviyoConsumer {
  constructor(
    private readonly klaviyoUrl: string,
    private readonly klaviyoKey: string,
    private readonly send: Fetch,
  ) {}

  /** `KlaviyoService.sendEvent`: throws `new Error(await response.text())` on any non-2xx. */
  async sendEvent(payload: KlaviyoOrderPayload, eventType: string): Promise<void> {
    let constructedPayload: object = {}
    if (eventType === KLAVIYO_EVENTS.ORDERED_EVENT) {
      constructedPayload = orderedProductEvent(payload, eventType)
    } else if (eventType === KLAVIYO_EVENTS.PLACE_ORDER) {
      constructedPayload = placedOrderEvent(payload, eventType)
    }
    const headers = new Headers()
    headers.append("revision", "2024-02-15")
    headers.append("Authorization", `Klaviyo-API-Key ${this.klaviyoKey}`)
    headers.append("Content-Type", "application/json")
    const response = await this.send(
      new Request(this.klaviyoUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(constructedPayload),
      }),
    )
    if (!response.ok) {
      const errorMessages: string = await response.text()
      throw new Error(errorMessages)
    }
  }

  /** `OfferingsQueue.pushDataToKlaviyo`: Ordered Product, then Placed Order; rethrows. */
  async pushDataToKlaviyo(payload: KlaviyoOrderPayload): Promise<void> {
    await this.sendEvent(payload, KLAVIYO_EVENTS.ORDERED_EVENT)
    await this.sendEvent(payload, KLAVIYO_EVENTS.PLACE_ORDER)
  }
}

/** The payload `createAnalyticsAndTrackingJobs` builds from a user and their first order line. */
export const checkoutPayload = (input: {
  userToken: string | null
  email: string
  phoneNumber: string
  stripeProductId: string
  productName: string
  amount: string | null
  orderSourceReference: string
  now?: Date
}): KlaviyoOrderPayload => ({
  ProductId: input.stripeProductId,
  ProductName: input.productName,
  Quantity: 1,
  time: (input.now ?? new Date()).toISOString(),
  value: Number.parseInt(input.amount ?? "0", 10),
  value_currency: "USD",
  unique_id: input.orderSourceReference,
  id: input.userToken ?? "",
  email: input.email,
  phone_number: input.phoneNumber,
})
