import process from "node:process"

const MANAGEMENT_BASE_URL = "https://api.management.junction.com"
const REQUIRED_ENV = [
  "MOCKINGBIRD_JUNCTION_MANAGEMENT_KEY",
  "MOCKINGBIRD_JUNCTION_ORG_ID",
  "MOCKINGBIRD_JUNCTION_TEAM_ID",
  "MOCKINGBIRD_JUNCTION_WEBHOOK_URL",
] as const
const EVENT_TYPES = ["labtest.order.created", "labtest.order.updated"]

type Webhook = {
  id: string
  url: string
  disabled?: boolean | null
  filter_types?: readonly string[] | null
}

type WebhookList = {
  data?: readonly Webhook[]
  webhooks?: readonly Webhook[]
}

const envValue = (name: (typeof REQUIRED_ENV)[number]) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const config = {
  managementKey: envValue("MOCKINGBIRD_JUNCTION_MANAGEMENT_KEY"),
  orgId: envValue("MOCKINGBIRD_JUNCTION_ORG_ID"),
  teamId: envValue("MOCKINGBIRD_JUNCTION_TEAM_ID"),
  webhookUrl: envValue("MOCKINGBIRD_JUNCTION_WEBHOOK_URL").replace(/\/$/, ""),
}

const endpoint = `${MANAGEMENT_BASE_URL}/v1/org/${config.orgId}/team/${config.teamId}/sandbox/webhook`
const headers = {
  "content-type": "application/json",
  "x-management-key": config.managementKey,
}

const managementRequest = async (input: string, init?: RequestInit) => {
  const response = await fetch(input, { ...init, headers: { ...headers, ...init?.headers } })
  if (!response.ok) throw new Error(`Junction Management API ${response.status} at ${input}`)
  return response
}

const listWebhooks = async () => {
  const response = await managementRequest(endpoint)
  const body = (await response.json()) as WebhookList
  return body.data ?? body.webhooks ?? []
}

const desired = (webhook: Webhook) => {
  const filterTypes = webhook.filter_types
  return (
    webhook.url.replace(/\/$/, "") === config.webhookUrl &&
    webhook.disabled !== true &&
    (filterTypes === null ||
      filterTypes === undefined ||
      EVENT_TYPES.every((eventType) => filterTypes?.includes(eventType) ?? false))
  )
}
const main = async () => {
  const matches = (await listWebhooks()).filter(
    (webhook) => webhook.url.replace(/\/$/, "") === config.webhookUrl,
  )
  const current = matches[0]
  if (current && !desired(current)) {
    throw new Error(
      `Webhook ${current.id} exists at ${config.webhookUrl} but is not configured for parity`,
    )
  }
  if (current) {
    console.log(`junction webhook registered: ${config.webhookUrl} (${current.id})`)
    return
  }
  const response = await managementRequest(endpoint, {
    method: "POST",
    body: JSON.stringify({
      url: config.webhookUrl,
      description: "Mockingbird Junction parity receiver",
      disabled: false,
      filter_types: EVENT_TYPES,
    }),
  })
  const webhook = (await response.json()) as Webhook
  console.log(`junction webhook registered: ${config.webhookUrl} (${webhook.id})`)
}

await main()
