import process from "node:process"

const EVENT_TYPES = ["labtest.order.created", "labtest.order.updated"] as const
const receiverUrl = process.env.MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL?.trim().replace(/\/$/, "")

if (!receiverUrl) {
  throw new Error("MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL is required")
}

const healthUrl = `${receiverUrl}/health`
const response = await fetch(healthUrl)
if (!response.ok) {
  throw new Error(`Junction webhook receiver returned ${response.status} at ${healthUrl}`)
}

const webhookUrl = `${receiverUrl}/junction/webhooks`
console.log(`junction webhook receiver is ready: ${receiverUrl}`)
console.log(`Configure this URL in the Junction sandbox dashboard: ${webhookUrl}`)
console.log(`Enable these event types: ${EVENT_TYPES.join(", ")}`)
