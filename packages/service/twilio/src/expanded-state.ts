import { getTwilioStore, type ProviderExpansion } from "@crvouga/mockingbird-http-provider"
import type { MessageRecord, TwilioState } from "./state.js"

export function syncToExpanded(state: TwilioState, expansion: ProviderExpansion): void {
  const messages = getTwilioStore(expansion.store).messages
  // Oldest first: the expansion lists by its own row id, newest (highest) first, so rows must
  // be inserted in creation order for both surfaces to page in the same order (#762).
  for (const { value: message } of state.messages.list({ order: "oldest" })) {
    const existing = messages.findOneBy("sid", message.sid)
    const value = {
      sid: message.sid,
      account_sid: message.account_sid,
      to: message.to,
      from: message.from,
      body: message.body,
      direction: message.direction,
      status: message.status,
      messaging_service_sid: message.messaging_service_sid,
      num_segments: message.num_segments,
      num_media: message.num_media,
      media_urls: state.outbox.get(message.sid)?.mediaUrls ?? [],
      error_code: message.error_code,
      error_message: message.error_message,
      price: message.price,
      price_unit: message.price_unit,
      api_version: message.api_version,
      status_callback: null,
      date_sent: message.date_sent,
    }
    if (existing) {
      if (existing.body !== value.body || existing.status !== value.status)
        messages.update(existing.id, value)
    } else messages.insert(value)
    if (!expansion.store.meta.has(`native-twilio-message:${message.sid}`))
      expansion.store.meta.insert(`native-twilio-message:${message.sid}`, true)
  }
}

export function syncFromExpanded(state: TwilioState, expansion: ProviderExpansion): void {
  const messages = getTwilioStore(expansion.store).messages
  for (const row of state.messages.list())
    if (
      expansion.store.meta.has(`native-twilio-message:${row.id}`) &&
      !messages.findOneBy("sid", row.id)
    )
      state.messages.delete(row.id)
  for (const message of getTwilioStore(expansion.store).messages.all()) {
    const existing = state.messages.get(message.sid)
    const created = new Date(message.created_at).toUTCString()
    const value: MessageRecord = {
      sid: message.sid,
      account_sid: message.account_sid,
      api_version: "2010-04-01",
      body: message.body ?? "",
      to: message.to,
      from: message.from,
      messaging_service_sid: message.messaging_service_sid,
      status: message.status,
      direction: message.direction,
      num_segments: message.num_segments,
      num_media: message.num_media,
      price: message.price,
      price_unit: "USD",
      error_code: message.error_code,
      error_message: message.error_message,
      date_created: existing?.date_created ?? created,
      date_updated: new Date(message.updated_at).toUTCString(),
      date_sent: message.date_sent,
      uri: `/2010-04-01/Accounts/${message.account_sid}/Messages/${message.sid}.json`,
      subresource_uris: {
        media: `/2010-04-01/Accounts/${message.account_sid}/Messages/${message.sid}/Media.json`,
        feedback: `/2010-04-01/Accounts/${message.account_sid}/Messages/${message.sid}/Feedback.json`,
      },
    }
    if (!expansion.store.meta.has(`native-twilio-message:${message.sid}`))
      expansion.store.meta.insert(`native-twilio-message:${message.sid}`, true)
    if (existing) state.messages.update(message.sid, value)
    else {
      state.messages.insert(message.sid, value)
      state.outbox.record({
        id: message.sid,
        createdAt: message.created_at,
        kind: "sms",
        sid: message.sid,
        to: message.to,
        from: message.from,
        messagingServiceSid: message.messaging_service_sid,
        body: message.body ?? "",
        channel: "sms",
        mediaUrls: message.media_urls,
      })
    }
  }
}
