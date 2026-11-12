import type { Meta, StoryObj } from "@storybook/html-vite"
import { ADMIN, cove, PATIENT, person, phone, SHELL } from "./cove.js"

/**
 * Administration: the workspace's members and their roles, drawn by the shared admin UI's
 * members table (`@crvouga/mockingbird-admin-ui`) over the app's own `/api/admin`. Only
 * administrators get it.
 */
export default {
  title: "Examples/Medical testing/Administration",
  parameters: {
    layout: "fullscreen",
    sources: [...SHELL, "packages/examples/medical-testing/src/client/pages/Admin.ts"],
  },
} satisfies Meta

const members = (extra: Parameters<typeof cove>[1] = {}): StoryObj => ({
  ...cove({ as: ADMIN, route: "admin" }, extra),
  play: async ({ canvasElement }) => {
    await person(canvasElement).find(
      ".cove-page table, .cove-page [role='table'], .cove-page [role='grid']",
    )
  },
})

/** The members table, as an administrator. */
export const Members: StoryObj = members()

/** A patient who opens Administration: access restricted. */
export const AccessRestricted: StoryObj = cove({ as: PATIENT, route: "admin" })

export const OnAPhone: StoryObj = members({ globals: phone })
