import { createWebhookCollector } from "@crvouga/mockingbird-webhook-collector"
import type { APIRoute } from "astro"
import { webhookStore } from "../../lib/webhook-store.js"

/** Pass all collector paths to the same Hono app; providers need no Astro route changes. */
export const ALL: APIRoute = async ({ request }) => {
  const url = new URL(request.url)
  url.pathname = url.pathname.replace(/^\/webhook(?=\/|$)/, "") || "/"
  return createWebhookCollector(webhookStore(), process.env.WEBHOOK_READ_TOKEN).fetch(
    new Request(url, request),
  )
}

export const prerender = false
