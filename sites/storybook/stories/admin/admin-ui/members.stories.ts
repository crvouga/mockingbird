import type { AdminFetch, MembersConfig } from "@crvouga/mockingbird-admin-ui/browser"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { userEvent, within } from "storybook/test"
import { choose, members, shows } from "./admin.js"

/**
 * The members screen an application embeds with `mountMembers` (the medical-testing example's
 * admin page does): members and their roles, the permission matrix, the audit log. It reads
 * `GET <apiPrefix>/admin` and changes a role with `PATCH <apiPrefix>/admin/users/:id`; the story
 * answers both from a small in-memory workspace.
 */
export default {
  title: "Admin/Admin UI/Members",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/admin-ui/src/members.tsx",
      "packages/admin-ui/src/browser.tsx",
      "packages/admin-ui/src/components.tsx",
      "packages/admin-ui/src/model.ts",
    ],
  },
} satisfies Meta

const ROLES = ["patient", "clinician", "admin"]
const config = (dark = false): MembersConfig => ({
  currentUserId: "usr_admin",
  roles: ROLES,
  permissions: {
    patient: ["orders.own", "orders.create", "profile.edit"],
    clinician: ["orders.own", "orders.create", "profile.edit", "orders.read", "results.review"],
    admin: [
      "orders.own",
      "orders.create",
      "profile.edit",
      "orders.read",
      "results.review",
      "users.manage",
      "audit.read",
    ],
  },
  apiPrefix: "/api",
  dark,
})

/** A workspace of four members and the role changes and reviews made so far. */
function workspace(): AdminFetch {
  const users = [
    {
      id: "usr_admin",
      name: "Grace Hopper",
      email: "grace@clinic.example",
      role: "admin",
      provider: "google",
    },
    {
      id: "usr_alice",
      name: "Alice Liddell",
      email: "alice@gmail.com",
      role: "patient",
      provider: "email",
    },
    {
      id: "usr_bob",
      name: "Bob Marley",
      email: "bob@example.com",
      role: "clinician",
      provider: "apple",
    },
    { id: "usr_carol", name: null, email: "carol@example.com", role: "patient", provider: "email" },
  ]
  const audit = [
    {
      createdAt: "2026-11-10T15:04:00Z",
      actor: "grace@clinic.example",
      action: "role.change",
      target: "bob@example.com",
    },
    {
      createdAt: "2026-11-11T09:30:00Z",
      actor: "bob@example.com",
      action: "results.review",
      target: "order_1042",
    },
    {
      createdAt: "2026-11-12T08:12:00Z",
      actor: "alice@gmail.com",
      action: "document.download",
      target: "result_1042.pdf",
    },
  ]
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      "https://app.example",
    )
    const method = init?.method ?? "GET"
    if (method === "GET" && url.pathname === "/api/admin")
      return Response.json({ users, audit: [...audit].reverse() })
    const match = /^\/api\/admin\/users\/([^/]+)$/.exec(url.pathname)
    const user = users.find((candidate) => candidate.id === decodeURIComponent(match?.[1] ?? ""))
    if (method === "PATCH" && user) {
      user.role = (JSON.parse(String(init?.body)) as { role: string }).role
      audit.push({
        createdAt: new Date().toISOString(),
        actor: "grace@clinic.example",
        action: "role.change",
        target: user.email,
      })
      return Response.json({ ok: true })
    }
    return Response.json({ error: "not_found" }, { status: 404 })
  }
}

/** Members and their roles; your own row is locked. */
export const Members: StoryObj = members(config(), workspace(), { ready: "carol@example.com" })

export const RolePermissions: StoryObj = members(config(), workspace(), {
  ready: "carol@example.com",
})
RolePermissions.play = async ({ canvasElement }) => {
  await shows(canvasElement, "carol@example.com")
  await userEvent.click(within(canvasElement).getByRole("tab", { name: "Role permissions" }))
  await shows(canvasElement, "users.manage")
}

export const AuditLog: StoryObj = members(config(), workspace(), { ready: "carol@example.com" })
AuditLog.play = async ({ canvasElement }) => {
  await shows(canvasElement, "carol@example.com")
  await userEvent.click(within(canvasElement).getByRole("tab", { name: "Audit log" }))
  await shows(canvasElement, "result_1042.pdf")
}

/** A new role picked: the confirmation before access changes. */
export const ChangeRoleConfirmation: StoryObj = members(config(), workspace(), {
  ready: "carol@example.com",
})
ChangeRoleConfirmation.play = async ({ canvasElement }) => {
  await pickClinician(canvasElement)
}

async function pickClinician(canvas: HTMLElement): Promise<void> {
  await shows(canvas, "carol@example.com")
  await choose(canvas, "Role for Alice Liddell", "clin", "clinician")
  await shows(canvas, "Change Alice Liddell to clinician?")
}

/** Confirmed: the role is changed and the change is in the audit log. */
export const RoleChanged: StoryObj = members(config(), workspace(), { ready: "carol@example.com" })
RoleChanged.play = async ({ canvasElement }) => {
  await pickClinician(canvasElement)
  await userEvent.click(within(canvasElement).getByRole("button", { name: "Change role" }))
  await shows(canvasElement, "Member access updated")
}

export const DarkTheme: StoryObj = members(config(true), workspace(), {
  ready: "carol@example.com",
})

/** The application's API refuses: the error, with Try again. */
export const LoadFailed: StoryObj = members(
  config(),
  async () => Response.json({ error: "Only admins can manage members" }, { status: 403 }),
  { ready: "Only admins can manage members" },
)
