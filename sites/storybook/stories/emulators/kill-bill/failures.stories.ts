import { createRuntime } from "@crvouga/mockingbird-service-kill-bill"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { markup } from "../../../src/story.js"

/**
 * What Kill Bill answers in HTML: Tomcat's own 404 page, for a request Kill Bill answers with no
 * entity. Invoicing an account that has nothing due is a POST, which a browser never makes by
 * address, so the story shows the body the real emulator answered to one.
 */
export default {
  title: "Emulators/Kill Bill/Failure pages",
  parameters: { layout: "fullscreen", sources: ["packages/service/kill-bill/src/index.ts"] },
} satisfies Meta

const ORIGIN = "https://killbill.example"
const HEADERS = {
  authorization: `Basic ${btoa("admin:password")}`,
  "content-type": "application/json",
  "x-killbill-apikey": "bob",
  "x-killbill-apisecret": "lazar",
  "x-killbill-createdby": "storybook",
}

/** Renewal invoicing run twice for the same date: the second finds nothing due. */
export const TomcatNotFound: StoryObj = markup(async () => {
  const emulator = createRuntime({
    plans: [{ name: "monthly-100", amount: 100, currency: "USD", intervalDays: 30 }],
  })
  const kb = (path: string, method = "GET", body?: unknown) =>
    emulator.fetch(
      new Request(`${ORIGIN}/1.0/kb${path}`, {
        method,
        headers: HEADERS,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  await kb("/test/clock?requestedDate=2030-01-01", "POST")
  const account = await kb("/accounts", "POST", { currency: "USD" })
  const accountId = account.headers.get("location")?.split("/").at(-1) ?? ""
  await kb(`/accounts/${accountId}/paymentMethods?isDefault=true`, "POST", {
    pluginName: "__EXTERNAL_PAYMENT__",
  })
  await kb("/subscriptions", "POST", { accountId, planName: "monthly-100" })
  await kb(`/invoices?accountId=${accountId}&targetDate=2030-02-01`, "POST")
  const again = await kb(`/invoices?accountId=${accountId}&targetDate=2030-02-01`, "POST")
  return again.text()
})
