import { createRuntime } from "@crvouga/mockingbird-service-linear"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { call, inspector, openTab, phone, SHARED_SOURCES } from "./inspector.js"

/**
 * The Linear emulator's inspector (`/`): issues, teams, users, projects and cycles, agent
 * sessions, OAuth apps and tokens, webhooks. The stories file issues and subscribe a webhook
 * through Linear's GraphQL API.
 */
export default {
  title: "Admin/Inspectors/Linear",
  parameters: {
    layout: "fullscreen",
    sources: [...SHARED_SOURCES, "packages/http/provider/src/vendor/linear/routes/inspector.ts"],
  },
} satisfies Meta

const ORIGIN = "https://api.linear.app"

/** A workspace with a few more issues filed and a webhook subscribed. */
async function workspace() {
  const linear = createRuntime()
  const graphql = async (query: string) =>
    JSON.parse(
      await call(linear, `${ORIGIN}/graphql`, {
        method: "POST",
        headers: { authorization: "Bearer lin_test_admin", "content-type": "application/json" },
        body: JSON.stringify({ query }),
      }),
    ) as { data: { teams?: { nodes: { id: string }[] } } }
  const team = (await graphql("{ teams { nodes { id } } }")).data.teams?.nodes[0]?.id ?? ""
  for (const [title, priority] of [
    ["Checkout times out on slow networks", 1],
    ["Receipt email shows the wrong currency", 2],
    ["Add Apple Pay to the portal", 3],
  ] as const)
    await graphql(
      `mutation { issueCreate(input: { teamId: "${team}", title: "${title}", priority: ${priority} }) { success } }`,
    )
  await graphql(
    `mutation { webhookCreate(input: { url: "https://gamezilla.dev/hooks/linear", teamId: "${team}", resourceTypes: ["Issue", "Comment"] }) { success } }`,
  )
  return linear
}

const tab = (name: string, text: string) => inspector(workspace, `${ORIGIN}/?tab=${name}`, text)

export const Issues: StoryObj = tab("issues", "Receipt email shows the wrong currency")

export const Teams: StoryObj = tab("teams", "Engineering")

export const Users: StoryObj = tab("users", "dev@linear.local")

/** Projects and cycles. */
export const Projects: StoryObj = tab("projects", "Cycle 1")

/** No agent sessions yet. */
export const Agents: StoryObj = tab("agents", "No agent sessions.")

/** OAuth apps and tokens, tokens masked. */
export const Auth: StoryObj = tab("auth", "My Linear App")

export const Webhooks: StoryObj = tab("webhooks", "https://gamezilla.dev/hooks/linear")

/** Following the Teams tab from Issues. */
export const SwitchingTabs: StoryObj = {
  ...Issues,
  play: async ({ canvasElement }) => openTab(canvasElement, "Teams", "Backlog"),
}

export const OnAPhone: StoryObj = { ...Issues, globals: phone }
