import { describe, expect, test } from "bun:test"
import { NotificationClient } from "@crvouga/mockingbird-notifications"
import { orderRef } from "./src/app/notifications/patientNotifications.js"
import { ApiError, api, setFetcher } from "./src/client/api.js"
import { buildDemo, type Demo } from "./src/composition/build.js"
import { createInProcessFetcher } from "./src/composition/inProcessFetcher.js"
import { createServerFetch } from "./src/composition/server.js"
import {
  DECLINED_CARD,
  payWithHostedCheckout,
  signInWithGoogle,
  waitUntil,
} from "./testing/inProcessFlow.js"

const ADA_EMAIL = "ada@example.test"
const ADA_PHONE = "+14155550100"
const NEW_EMAIL = "grace.hopper@example.com"
const NEW_PHONE = "+14155550142"

const startDemo = async () => {
  const demo = await buildDemo({ html: "", js: "" })
  setFetcher(createInProcessFetcher(demo.app))
  return demo
}

/** Runs one scenario against a fresh app and closes its harness afterwards. */
const withDemo = async (run: (demo: Demo) => Promise<void>): Promise<void> => {
  const demo = await startDemo()
  try {
    await run(demo)
  } finally {
    demo.notifications.close()
  }
}

/** The harness over its HTTP API, the way a test in another process reads it. */
const inbox = (demo: Demo) =>
  new NotificationClient("http://harness.local", { fetch: demo.notifications.fetch })

/** Asks for a sign-in email and returns the code and link it carried. */
const requestSignInEmail = async (demo: Demo, email: string, nth = 1) => {
  await api.emailStart(email)
  const mails = await demo.notifications.waitFor(
    { channel: "email", to: email, contains: "sign-in code" },
    { count: nth },
  )
  const mail = mails.at(-1)
  const code = /^(\d{6}) is your Cove sign-in code$/.exec(mail?.email?.subject ?? "")?.[1]
  const link = /https?:\/\/\S+[?&]sign-in=[\w.-]+/.exec(mail?.email?.text ?? "")?.[0]
  if (!code || !link) throw new Error("the sign-in email carried no code or link")
  return { code, link, token: link.split("sign-in=")[1] as string, mail }
}

const signInWithEmail = async (demo: Demo, email: string, nth = 1) => {
  const { code } = await requestSignInEmail(demo, email, nth)
  return api.emailVerify(email, code)
}

/** Lets a second code be requested now instead of after the resend cooldown. */
const skipCooldown = (demo: Demo, email: string) =>
  demo.db.query("UPDATE sign_in_codes SET created_at = $2 WHERE email = $1", [
    email,
    new Date(Date.now() - 60_000).toISOString(),
  ])

const rejection = async (work: Promise<unknown>): Promise<ApiError> => {
  try {
    await work
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error("expected the request to be refused")
}

const wrongCode = (code: string): string => (code === "000000" ? "000001" : "000000")

const checkout = async (card?: string): Promise<string> => {
  const { tests } = await api.tests()
  const testId = tests[0]?.id
  if (!testId) throw new Error("no lab tests seeded")
  const { orderId, checkoutSessionId } = await api.checkout([testId])
  await payWithHostedCheckout(checkoutSessionId, card)
  return orderId
}

/** Buys one test, pays, and waits until the lab reports results. */
const buyAndSettle = async (): Promise<string> => {
  const orderId = await checkout()
  await waitUntil(async () => {
    const { orders } = await api.orders()
    return orders.find((o) => o.id === orderId)?.status === "results_ready"
  })
  return orderId
}

/** Lets any in-flight send land before asserting on what did not arrive. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 250))

describe("order lifecycle (Resend, Twilio, FCM and Slack)", () => {
  test(
    "every step reaches the patient on email, text and both phones, and staff in Slack",
    () =>
      withDemo(async (demo) => {
        await signInWithGoogle("ada")
        const orderId = await buyAndSettle()
        const ref = orderRef(orderId)

        const emails = await demo.notifications.waitFor(
          { channel: "email", to: ADA_EMAIL, contains: ref },
          { count: 3 },
        )
        expect(emails.map((n) => n.email?.subject)).toEqual([
          `Your Cove receipt for order ${ref}`,
          `Your collection kit is on its way (order ${ref})`,
          `Your results are ready (order ${ref})`,
        ])
        const receipt = emails[0]
        expect(receipt?.service).toBe("resend")
        expect(receipt?.email?.html).toContain("Total paid")
        expect(receipt?.email?.text).toContain("Total paid")
        // One branded layout: every email carries the same header and footer.
        for (const mail of emails) expect(mail.email?.html).toContain("Cove <span")

        const texts = await demo.notifications.waitFor(
          { channel: "sms", to: ADA_PHONE },
          { count: 4 },
        )
        expect(texts.map((n) => n.sms?.body)).toEqual([
          expect.stringContaining(`payment received for order ${ref}`),
          expect.stringContaining("has shipped. USPS tracking"),
          expect.stringContaining("the lab received your sample"),
          expect.stringContaining(`results for order ${ref} are ready`),
        ])
        expect(texts[0]?.service).toBe("twilio")

        // Each member has an iPhone and an Android phone; both get every push.
        const pushes = await demo.notifications.waitFor(
          { channel: "push", service: "fcm" },
          { count: 8 },
        )
        for (const platform of ["android", "ios"] as const) {
          const onDevice = pushes.filter((n) => n.push?.platform === platform)
          expect(onDevice.map((n) => n.push?.title)).toEqual([
            "Order confirmed",
            "Your kit has shipped",
            "Sample received",
            "Your results are ready",
          ])
          expect(onDevice[0]?.to).toStartWith(`${platform}-`)
          expect(onDevice[0]?.push?.data).toMatchObject({
            type: "order.confirmed",
            orderId,
            orderRef: ref,
          })
        }

        const [paid] = await demo.notifications.waitFor({ channel: "chat", to: "#lab-orders" })
        expect(paid?.service).toBe("slack")
        expect(paid?.chat?.workspace).toBe("Cove")
        expect(paid?.chat?.text).toContain(`New paid order *${ref}*`)
        const [review] = await demo.notifications.waitFor({
          channel: "chat",
          to: "#clinical-review",
        })
        expect(review?.chat?.text).toContain(`order ${ref}`)
        expect(JSON.stringify(review?.chat?.blocks)).toContain('"type":"header"')
        expect(JSON.stringify(review?.chat?.blocks)).toContain('"type":"actions"')

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
        const notes = await demo.notifications.waitFor(
          { channel: "push", contains: "Clinician note" },
          { count: 2 },
        )
        expect(notes.map((n) => n.push?.platform).sort()).toEqual(["android", "ios"])
      }),
    30_000,
  )

  test(
    "a declined card emails the patient and alerts billing, and the order stays unpaid",
    () =>
      withDemo(async (demo) => {
        await signInWithGoogle("ada")
        const orderId = await checkout(DECLINED_CARD)
        const ref = orderRef(orderId)
        const [failed] = await demo.notifications.waitFor({
          channel: "email",
          to: ADA_EMAIL,
          contains: "did not go through",
        })
        expect(failed?.email?.subject).toBe(`Your payment for order ${ref} did not go through`)
        const [alert] = await demo.notifications.waitFor({ channel: "chat", to: "#billing-alerts" })
        expect(alert?.chat?.text).toContain(ref)

        const order = (await api.orders()).orders.find((o) => o.id === orderId)
        expect(order?.status).toBe("pending_payment")
        expect(order?.timeline.map((event) => event.status)).toContain("payment_failed")
        await settle()
        expect(await demo.notifications.list({ channel: "sms" })).toEqual([])
        expect(await demo.notifications.list({ channel: "push" })).toEqual([])
      }),
    30_000,
  )
})

describe("passwordless email sign-in", () => {
  test("a new address gets a code, an account and a welcome email", () =>
    withDemo(async (demo) => {
      const { code, link, mail } = await requestSignInEmail(demo, NEW_EMAIL)
      expect(mail?.email?.html).toContain(code)
      expect(mail?.email?.html).toContain(link.replaceAll("&", "&amp;"))

      const { user, created } = await api.emailVerify(NEW_EMAIL, code)
      expect(created).toBe(true)
      expect(user).toMatchObject({
        email: NEW_EMAIL,
        provider: "email",
        role: "patient",
        name: "Grace Hopper",
        phone: null,
      })
      expect((await api.me()).user?.id).toBe(user.id)
      const [welcome] = await demo.notifications.waitFor({
        channel: "email",
        to: NEW_EMAIL,
        contains: "Welcome to Cove",
      })
      expect(welcome?.email?.subject).toBe("Welcome to Cove, Grace")

      // Signing in again is not a sign-up: it sends a security alert instead.
      await api.signOut()
      await skipCooldown(demo, NEW_EMAIL)
      const again = await signInWithEmail(demo, NEW_EMAIL, 2)
      expect(again.created).toBe(false)
      expect(again.user.id).toBe(user.id)
      const [alert] = await demo.notifications.waitFor({
        channel: "email",
        to: NEW_EMAIL,
        contains: "New sign-in",
      })
      expect(alert?.email?.text).toContain("an emailed code")
      expect(await demo.notifications.list({ to: NEW_EMAIL, contains: "Welcome" })).toHaveLength(1)
    }))

  test("the demo accounts sign in by email with their roles", () =>
    withDemo(async (demo) => {
      // Addresses are matched without regard to case or stray spaces.
      const started = await api.emailStart(" Clinician@Example.test ")
      expect(started.email).toBe("clinician@example.test")
      const [mail] = await demo.notifications.waitFor({ channel: "email", to: started.email })
      const code = mail?.email?.subject.slice(0, 6) ?? ""
      const { user, created } = await api.emailVerify("CLINICIAN@example.test", code)
      expect(created).toBe(false)
      expect(user).toMatchObject({ name: "Morgan Chen", role: "clinician" })
    }))

  test("the emailed link signs in once", () =>
    withDemo(async (demo) => {
      const { token, code } = await requestSignInEmail(demo, ADA_EMAIL)
      const { user } = await api.emailLink(token)
      expect(user.name).toBe("Ada Lovelace")
      const [alert] = await demo.notifications.waitFor({
        channel: "email",
        to: ADA_EMAIL,
        contains: "New sign-in",
      })
      expect(alert?.email?.text).toContain("an emailed link")

      // The link and the code are one credential: using either spends both.
      expect((await rejection(api.emailLink(token))).status).toBe(410)
      expect((await rejection(api.emailVerify(ADA_EMAIL, code))).status).toBe(410)
      expect((await rejection(api.emailLink("not-a-token"))).status).toBe(410)
    }))

  test("a code works once, and a newer code replaces an older one", () =>
    withDemo(async (demo) => {
      const first = await requestSignInEmail(demo, ADA_EMAIL)
      await skipCooldown(demo, ADA_EMAIL)
      const second = await requestSignInEmail(demo, ADA_EMAIL, 2)
      if (first.code !== second.code)
        expect((await rejection(api.emailVerify(ADA_EMAIL, first.code))).status).toBe(400)
      expect((await rejection(api.emailLink(first.token))).status).toBe(410)

      await api.emailVerify(ADA_EMAIL, second.code)
      const reuse = await rejection(api.emailVerify(ADA_EMAIL, second.code))
      expect(reuse.status).toBe(410)
      expect(reuse.message).toContain("expired or was already used")
    }))

  test("a code expires after ten minutes", () =>
    withDemo(async (demo) => {
      const { code, token } = await requestSignInEmail(demo, ADA_EMAIL)
      await demo.db.query("UPDATE sign_in_codes SET expires_at = $2 WHERE email = $1", [
        ADA_EMAIL,
        new Date(Date.now() - 1_000).toISOString(),
      ])
      expect((await rejection(api.emailVerify(ADA_EMAIL, code))).status).toBe(410)
      expect((await rejection(api.emailLink(token))).status).toBe(410)
      expect((await api.me()).user).toBeNull()
    }))

  test("five wrong guesses burn the code, even for the right one", () =>
    withDemo(async (demo) => {
      const { code } = await requestSignInEmail(demo, ADA_EMAIL)
      for (const left of [4, 3, 2, 1]) {
        const wrong = await rejection(api.emailVerify(ADA_EMAIL, wrongCode(code)))
        expect(wrong.status).toBe(400)
        expect(wrong.message).toContain(`${left} ${left === 1 ? "try" : "tries"} left`)
      }
      expect((await rejection(api.emailVerify(ADA_EMAIL, wrongCode(code)))).status).toBe(429)
      expect((await rejection(api.emailVerify(ADA_EMAIL, code))).status).toBe(429)
      expect((await api.me()).user).toBeNull()
    }))

  test("a second code cannot be requested inside the cooldown", () =>
    withDemo(async (demo) => {
      await requestSignInEmail(demo, ADA_EMAIL)
      const tooSoon = await rejection(api.emailStart(ADA_EMAIL))
      expect(tooSoon.status).toBe(429)
      expect(tooSoon.retryAfterSeconds).toBeGreaterThan(0)
      expect(tooSoon.retryAfterSeconds).toBeLessThanOrEqual(30)
      await settle()
      expect(await demo.notifications.list({ channel: "email", to: ADA_EMAIL })).toHaveLength(1)

      expect((await rejection(api.emailStart("not an email"))).status).toBe(400)
      expect((await rejection(api.emailVerify(ADA_EMAIL, "12ab"))).status).toBe(400)
    }))

  test("signing in with Google sends the same security alert", () =>
    withDemo(async (demo) => {
      await signInWithGoogle("ada")
      const [alert] = await demo.notifications.waitFor({
        channel: "email",
        to: ADA_EMAIL,
        contains: "New sign-in",
      })
      expect(alert?.email?.subject).toBe("New sign-in to your Cove account")
      expect(alert?.email?.text).toContain("Google")
    }))
})

describe("phone verification (Twilio Verify)", () => {
  test("a number joins the account only after its code checks out", () =>
    withDemo(async (demo) => {
      const { user } = await signInWithEmail(demo, NEW_EMAIL)
      expect(user.phone).toBeNull()
      expect((await rejection(api.testNotification("text"))).status).toBe(409)
      expect((await rejection(api.phoneStart("12345", "sms"))).status).toBe(400)

      const started = await api.phoneStart("(415) 555-0142", "sms")
      expect(started).toEqual({ phone: NEW_PHONE, channel: "sms" })
      const code = await inbox(demo).waitForCode(NEW_PHONE)
      expect(code).toMatch(/^\d{4,8}$/)

      const wrong = await rejection(api.phoneCheck(NEW_PHONE, "sms", wrongCode(code)))
      expect(wrong.status).toBe(400)
      expect((await api.me()).user?.phone).toBeNull()

      const checked = await api.phoneCheck(NEW_PHONE, "sms", code)
      expect(checked.user).toMatchObject({ phone: NEW_PHONE, phoneChannel: "sms" })
      const [confirmation] = await demo.notifications.waitFor({
        channel: "sms",
        to: NEW_PHONE,
        contains: "this number is verified",
      })
      expect(confirmation?.sms?.via).not.toBe("whatsapp")

      // A used code is spent.
      expect((await rejection(api.phoneCheck(NEW_PHONE, "sms", code))).status).toBe(410)

      // Order texts now go to the verified number.
      expect((await api.testNotification("text")).sent).toEqual({ channel: "sms", to: NEW_PHONE })

      expect((await api.phoneRemove()).user.phone).toBeNull()
      expect((await api.me()).user?.phone).toBeNull()
    }))

  test("WhatsApp delivers the code and the updates that follow", () =>
    withDemo(async (demo) => {
      await signInWithEmail(demo, NEW_EMAIL)
      await api.phoneStart(NEW_PHONE, "whatsapp")
      const [otp] = await demo.notifications.waitFor({ channel: "sms", to: NEW_PHONE })
      expect(otp?.sms?.via).toBe("whatsapp")
      const { user } = await api.phoneCheck(NEW_PHONE, "whatsapp", otp?.sms?.code ?? "")
      expect(user.phoneChannel).toBe("whatsapp")
      const [confirmation] = await demo.notifications.waitFor({
        channel: "sms",
        to: NEW_PHONE,
        contains: "this number is verified",
      })
      expect(confirmation?.sms?.via).toBe("whatsapp")
    }))
})

describe("notification preferences", () => {
  test(
    "a channel that is switched off gets no order updates; the others still do",
    () =>
      withDemo(async (demo) => {
        const ada = await signInWithGoogle("ada")
        const { user } = await api.profile(ada.name ?? "Ada Lovelace", true, {
          email: true,
          text: false,
          push: false,
        })
        expect(user.notify).toEqual({ email: true, text: false, push: false })
        const orderId = await buyAndSettle()
        await demo.notifications.waitFor({
          channel: "email",
          to: ADA_EMAIL,
          contains: `results are ready (order ${orderRef(orderId)})`,
        })
        await settle()
        expect(await demo.notifications.list({ channel: "sms" })).toEqual([])
        expect(await demo.notifications.list({ channel: "push" })).toEqual([])
        // Staff alerts are not the patient's to switch off.
        expect(await demo.notifications.list({ channel: "chat" })).toHaveLength(2)
      }),
    30_000,
  )

  test(
    "with everything off, security email and requested tests still arrive",
    () =>
      withDemo(async (demo) => {
        const ada = await signInWithGoogle("ada")
        await api.profile(ada.name ?? "Ada Lovelace", true, {
          email: false,
          text: false,
          push: false,
        })
        await buyAndSettle()
        await settle()
        const patientFacing = (await demo.notifications.list()).filter((n) => n.channel !== "chat")
        // Only the alert from the Google sign-in above: no receipt, no texts, no pushes.
        expect(patientFacing.map((n) => n.email?.subject)).toEqual([
          "New sign-in to your Cove account",
        ])

        // Security messages ignore preferences: the next sign-in code still arrives.
        await api.signOut()
        const { created } = await signInWithEmail(demo, ADA_EMAIL)
        expect(created).toBe(false)

        // And so does a test the member explicitly asked for.
        expect((await api.testNotification("push")).sent.channel).toBe("push")
        await demo.notifications.waitFor(
          { channel: "push", contains: "Push is working" },
          { count: 2 },
        )
      }),
    30_000,
  )

  test("the profile endpoint refuses malformed preferences and keeps old clients working", () =>
    withDemo(async () => {
      const ada = await signInWithGoogle("ada")
      const bad = { email: "yes" } as unknown as { email: boolean; text: boolean; push: boolean }
      expect((await rejection(api.profile("Ada Lovelace", true, bad))).status).toBe(400)
      // A client that sends no `notify` leaves the channels as they were.
      const { user } = await api.profile("Ada L.", false)
      expect(user.name).toBe("Ada L.")
      expect(user.notify).toEqual(ada.notify)
    }))
})

describe("send a test notification", () => {
  test("patients test their own channels; the staff alert is for staff", () =>
    withDemo(async (demo) => {
      await signInWithGoogle("ada")
      expect((await api.testNotification("email")).sent).toEqual({
        channel: "email",
        to: ADA_EMAIL,
      })
      expect((await api.testNotification("text")).sent).toEqual({ channel: "sms", to: ADA_PHONE })
      expect((await rejection(api.testNotification("chat"))).status).toBe(403)
      expect((await rejection(api.testNotification("fax" as unknown as "email"))).status).toBe(400)

      await api.signOut()
      await signInWithGoogle("clinician")
      expect((await api.testNotification("chat")).sent).toEqual({
        channel: "chat",
        to: "#lab-orders",
      })
      const [posted] = await demo.notifications.waitFor({ channel: "chat", to: "#lab-orders" })
      expect(posted?.chat?.text).toContain("Morgan Chen sent a test alert")
    }))

  test("the account endpoints need a session", () =>
    withDemo(async () => {
      expect((await rejection(api.testNotification("email"))).status).toBe(401)
      expect((await rejection(api.phoneStart(NEW_PHONE, "sms"))).status).toBe(401)
    }))
})

describe("the standalone server", () => {
  test("serves the harness under /notifications/", () =>
    withDemo(async (demo) => {
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
    }))

  test("emails a sign-in link that points back at the server", () =>
    withDemo(async (demo) => {
      const serve = createServerFetch(demo)
      const started = await serve(
        new Request("http://localhost:4300/api/auth/email/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: ADA_EMAIL }),
        }),
      )
      expect(started.status).toBe(200)
      const [mail] = await demo.notifications.waitFor({ channel: "email", to: ADA_EMAIL })
      expect(mail?.email?.text).toContain("http://localhost:4300/?sign-in=")
    }))
})
