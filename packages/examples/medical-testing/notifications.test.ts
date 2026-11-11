import { describe, expect, test } from "bun:test"
import { orderRef } from "./src/app/notifications/patientNotifications.js"
import { api, setFetcher } from "./src/client/api.js"
import { buildDemo } from "./src/composition/build.js"
import { createInProcessFetcher } from "./src/composition/inProcessFetcher.js"
import { createServerFetch } from "./src/composition/server.js"
import { payWithHostedCheckout, signInWithGoogle, waitUntil } from "./testing/inProcessFlow.js"

const ADA_EMAIL = "ada@example.test"
const PATIENT_PHONE = "+14155550100"

const startDemo = async () => {
  const demo = await buildDemo({ html: "", js: "" })
  setFetcher(createInProcessFetcher(demo.app))
  return demo
}

/** Signs in as Ada, buys one test, pays, and waits until the lab reports results. */
const buyAndSettle = async (): Promise<string> => {
  const { tests } = await api.tests()
  const testId = tests[0]?.id
  if (!testId) throw new Error("no lab tests seeded")
  const { orderId, checkoutSessionId } = await api.checkout([testId])
  await payWithHostedCheckout(checkoutSessionId)
  await waitUntil(async () => {
    const { orders } = await api.orders()
    return orders.find((o) => o.id === orderId)?.status === "results_ready"
  })
  return orderId
}

describe("patient notifications (in-process Resend, Twilio and FCM)", () => {
  test("payment, sample processing, results and review reach the patient on every channel", async () => {
    const demo = await startDemo()
    try {
      const ada = await signInWithGoogle("ada")
      const orderId = await buyAndSettle()
      const ref = orderRef(orderId)

      const [receipt] = await demo.notifications.waitFor({
        channel: "email",
        to: ADA_EMAIL,
        contains: "receipt",
      })
      expect(receipt?.email?.subject).toBe(`Your Cove receipt for order ${ref}`)
      expect(receipt?.email?.html).toContain("Total paid")
      expect(receipt?.email?.text).toContain("Total paid")
      expect(receipt?.service).toBe("resend")

      const texts = await demo.notifications.waitFor(
        { channel: "sms", to: PATIENT_PHONE },
        { count: 2 },
      )
      expect(texts.map((n) => n.sms?.body)).toEqual([
        expect.stringContaining(`payment received for order ${ref}`),
        expect.stringContaining("results for order"),
      ])

      const pushes = await demo.notifications.waitFor(
        { channel: "push", service: "fcm" },
        { count: 2 },
      )
      expect(pushes.map((n) => n.push?.title)).toEqual([
        "Sample received",
        "Your results are ready",
      ])
      // Google sign-ins get a fictional Android device; the harness skins it as one.
      expect(pushes[0]?.push?.platform).toBe("android")
      expect(pushes[0]?.to).toStartWith("android-")

      await demo.notifications.waitFor({
        channel: "email",
        to: ADA_EMAIL,
        contains: "results are ready",
      })

      // A clinician reviews the report; Ada hears about it by email and push.
      await api.signOut()
      await signInWithGoogle("clinician")
      await api.review(orderId, "Everything looks within range. No follow-up needed.")
      const [reviewed] = await demo.notifications.waitFor({
        channel: "email",
        to: ADA_EMAIL,
        contains: "reviewed",
      })
      expect(reviewed?.email?.subject).toBe(`A clinician reviewed your results (order ${ref})`)
      const [notePush] = await demo.notifications.waitFor({
        channel: "push",
        contains: "Clinician note",
      })
      expect(notePush?.to).toBe(pushes[0]?.to as string)
      expect(ada.notifications).toBe(true)
    } finally {
      demo.notifications.close()
    }
  }, 20_000)

  test("turning order updates off in Account stops every message", async () => {
    const demo = await startDemo()
    try {
      const ada = await signInWithGoogle("ada")
      await api.profile(ada.name ?? "Ada Lovelace", false)
      await buyAndSettle()
      // Let any in-flight send land before asserting nothing arrived.
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(await demo.notifications.list()).toEqual([])
    } finally {
      demo.notifications.close()
    }
  }, 20_000)

  test("the standalone server serves the harness under /notifications/", async () => {
    const demo = await startDemo()
    try {
      const serve = createServerFetch(demo)
      const redirect = await serve(new Request("http://localhost:4300/notifications"))
      expect(redirect.status).toBe(308)
      expect(redirect.headers.get("location")).toBe("http://localhost:4300/notifications/")

      const page = await serve(new Request("http://localhost:4300/notifications/"))
      expect(page.status).toBe(200)
      expect(page.headers.get("content-type")).toContain("text/html")
      expect(await page.text()).toContain("Cove notifications")

      const sources = await serve(new Request("http://localhost:4300/notifications/api/sources"))
      expect(sources.status).toBe(200)
      const listed = await serve(
        new Request("http://localhost:4300/notifications/api/notifications"),
      )
      expect(listed.status).toBe(200)

      const app = await serve(new Request("http://localhost:4300/api/auth/me"))
      expect(app.status).toBe(200)
    } finally {
      demo.notifications.close()
    }
  })
})
