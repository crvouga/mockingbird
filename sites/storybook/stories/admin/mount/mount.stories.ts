import { mount } from "@crvouga/mockingbird-core"
import { createRuntime as resend } from "@crvouga/mockingbird-service-resend"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { hands } from "../../../src/interact.js"
import { page } from "../../../src/story.js"
import { served } from "../admin-ui/admin.js"
import { ORIGIN, shop } from "../admin-ui/store.js"

/**
 * Emulators embedded under an application's origin with `mount(api, "/prefix")`: the pages they
 * serve come back with their root-relative links, forms and assets rewritten under the prefix,
 * and the admin page boots with the prefixed admin path. Each page is opened at its mounted
 * address and stays usable there.
 */
export default {
  title: "Admin/Mount/Pages under a prefix",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/core/src/mount.ts",
      "packages/service/core/src/admin-ui.ts",
      "packages/http/provider/src/vendor/resend/routes/inbox.ts",
    ],
  },
} satisfies Meta

/** Stripe's admin at `/payments/stripe/__admin/ui`: every admin request goes under the prefix. */
export const AdminUnderAPrefix: StoryObj = served(async () => {
  const { s } = await shop()
  return {
    emulator: mount(s.emulator, "/payments/stripe"),
    url: `${ORIGIN}/payments/stripe/__admin/ui`,
  }
}, "PostSubscriptions")

async function inbox() {
  const mail = resend()
  for (const subject of ["Welcome to Gamezilla", "Your receipt"])
    await mail.fetch(
      new Request("https://app.mock/emails", {
        method: "POST",
        headers: { authorization: "Bearer re_storybook", "content-type": "application/json" },
        body: JSON.stringify({
          from: "Gamezilla <hello@gamezilla.dev>",
          to: ["alice@gmail.com"],
          subject,
          text: "Hi!",
        }),
      }),
    )
  return mount(mail, "/email")
}

/** Resend's inbox at `/email/inbox`: each email links to `/email/inbox/:id`. */
export const InboxUnderAPrefix: StoryObj = {
  ...page(async () => ({ emulator: await inbox(), url: "https://app.mock/email/inbox" })),
  play: async ({ canvasElement }) => {
    const { doc } = await hands(canvasElement)
    const links = [...doc.querySelectorAll<HTMLAnchorElement>("a.app-link")].map((a) =>
      a.getAttribute("href"),
    )
    await expect(links.every((href) => href?.startsWith("/email/inbox/"))).toBe(true)
  },
}

/** A rewritten link followed: the mounted emulator answers it. */
export const FollowingAMountedLink: StoryObj = {
  ...InboxUnderAPrefix,
  play: async ({ canvasElement }) => {
    const opened = await hands(canvasElement)
    opened.doc.querySelector<HTMLAnchorElement>("a.app-link")?.click()
    const email = await opened.navigated()
    await expect(email.doc.body.textContent).toContain("alice@gmail.com")
  },
}
