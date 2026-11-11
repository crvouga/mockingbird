/**
 * What the landing page's notifications demo sends. Every action is one real call to an emulator's
 * vendor API, the one an application's SDK would make, so the devices show what the emulators
 * recorded and nothing is drawn from a fixture. No DOM in here: `integrations/` tests it in Bun.
 *
 * All people, companies, numbers and addresses are fictional (`.example`, 555-01xx).
 */

/** An in-process emulator: `createRuntime()` from a service package. */
export type Runtime = { fetch(request: Request): Response | Promise<Response> }

export type DemoRuntimes = { twilio: Runtime; resend: Runtime; fcm: Runtime; slack: Runtime }

export type DemoChannel = "sms" | "push" | "email" | "chat"

export const DEMO_ACTIONS = ["code", "email", "push", "chat", "whatsapp"] as const
export type DemoAction = (typeof DEMO_ACTIONS)[number]

/** One call the demo made, as the caption under the buttons shows it. */
export type DemoCall = {
  action: DemoAction
  /** The device the message lands on. */
  channel: DemoChannel
  /** The emulator that answered. */
  service: keyof DemoRuntimes
  method: "POST"
  /** Host and path, with long ids shortened. */
  path: string
  status: number
}

const TWILIO_ACCOUNT = "AC00000000000000000000000000000000"
const VERIFY_SERVICE = "VA00000000000000000000000000000000"
const FCM_PROJECT = "demo-project"
const DEVICE_TOKEN = "ios-4c1d9a7e2f"
const SHOP_NUMBER = "+18885550100"
const WHATSAPP_NUMBER = "+14155550140"
/** The one fictional customer whose phone, lock screen and inbox the devices show. */
export const DEMO_CUSTOMER = { name: "Ada", phone: "+12025550123", email: "ada@example.com" }

const ITEMS = [
  { name: "Trail running shoes", price: 118 },
  { name: "Insulated water bottle", price: 32 },
  { name: "Merino wool socks", price: 24 },
  { name: "Packable rain jacket", price: 96 },
  { name: "Canvas day pack", price: 74 },
]
const COURIERS = ["Example Post", "Lakeside Courier", "Bluebird Parcel"]
const DAYS = ["Tuesday", "Wednesday", "Thursday", "Friday"]

const dollars = (amount: number) => `$${amount.toFixed(2)}`

const receiptHtml = (
  order: Order,
) => `<div style="max-width:520px;margin:0 auto;font-family:Helvetica,Arial,sans-serif;color:#1f2937">
<div style="padding:20px 0;border-bottom:1px solid #e5e7eb"><b style="font-size:20px;color:#4f46e5">acme</b></div>
<h1 style="font-size:21px;margin:22px 0 8px">Thanks for your order, ${DEMO_CUSTOMER.name}!</h1>
<p style="color:#4b5563;line-height:1.6;margin:0">We're getting order <b>#${order.number}</b> ready. You'll get another email when it ships.</p>
<table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:14px">
<tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6">${order.item.name} × 1</td><td style="text-align:right;border-bottom:1px solid #f3f4f6">${dollars(order.item.price)}</td></tr>
<tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6">Shipping</td><td style="text-align:right;border-bottom:1px solid #f3f4f6">${dollars(6)}</td></tr>
<tr><td style="padding:10px 0"><b>Total</b></td><td style="text-align:right"><b>${dollars(order.item.price + 6)}</b></td></tr></table>
<a href="https://acme.example/orders/${order.number}" style="display:inline-block;background:#4f46e5;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600">View your order</a>
<p style="color:#9ca3af;font-size:12px;margin-top:28px">Acme Outdoor Co. · 1 Example Way · Springfield</p></div>`

type Order = {
  number: number
  item: (typeof ITEMS)[number]
  courier: string
  day: string
}

/** `…/Accounts/AC00000000000000000000000000000000/…` is too long for a caption. */
const shorten = (path: string) => path.replace(/\b([A-Z]{2})0{6,}\b/g, "$1…")

export type NotificationsDemo = {
  /**
   * Make one call. Within a checkout, pass the same `order` to every call so the receipt, the
   * text, the push and the alert are about one order.
   */
  send(action: DemoAction, order?: number): Promise<DemoCall>
  /** Start a new order and return its number, for `send`. */
  nextOrder(): number
  /** Empty every emulator (`POST /__admin/reset`), as a test does between cases. */
  reset(): Promise<void>
}

export const createNotificationsDemo = (runtimes: DemoRuntimes): NotificationsDemo => {
  let orders = 0
  let registered: Promise<void> | null = null

  const orderFor = (index: number): Order => ({
    number: 1042 + index * 7,
    item: ITEMS[index % ITEMS.length] as Order["item"],
    courier: COURIERS[index % COURIERS.length] as string,
    day: DAYS[index % DAYS.length] as string,
  })

  const call = async (
    action: DemoAction,
    channel: DemoChannel,
    service: keyof DemoRuntimes,
    url: string,
    init: { headers: Record<string, string>; body: BodyInit },
  ): Promise<DemoCall> => {
    const response = await runtimes[service].fetch(new Request(url, { method: "POST", ...init }))
    await response.arrayBuffer()
    const { host, pathname } = new URL(url)
    return {
      action,
      channel,
      service,
      method: "POST",
      path: shorten(`${host}${pathname}`),
      status: response.status,
    }
  }

  const twilioHeaders = {
    authorization: `Basic ${btoa(`${TWILIO_ACCOUNT}:fixture-token`)}`,
    "content-type": "application/x-www-form-urlencoded",
  }
  const json = (token: string) => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  })

  /** FCM only delivers to a token a device registered; the demo's one phone registers once. */
  const registerDevice = () => {
    registered ??= Promise.resolve(
      runtimes.fcm.fetch(
        new Request("https://fcm.googleapis.com/__admin/tokens", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: DEVICE_TOKEN, platform: "ios", project: FCM_PROJECT }),
        }),
      ),
    ).then(async (response) => {
      await response.arrayBuffer()
    })
    return registered
  }

  const senders: Record<DemoAction, (order: Order, fresh: boolean) => Promise<DemoCall>> = {
    // A sign-in code comes from Twilio Verify, which makes up the code itself. Inside a checkout
    // the text is an order confirmation through the Messages API instead.
    code: (order, fresh) =>
      fresh
        ? call(
            "code",
            "sms",
            "twilio",
            `https://verify.twilio.com/v2/Services/${VERIFY_SERVICE}/Verifications`,
            {
              headers: twilioHeaders,
              body: new URLSearchParams({ To: DEMO_CUSTOMER.phone, Channel: "sms" }),
            },
          )
        : call(
            "code",
            "sms",
            "twilio",
            `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT}/Messages.json`,
            {
              headers: twilioHeaders,
              body: new URLSearchParams({
                To: DEMO_CUSTOMER.phone,
                From: SHOP_NUMBER,
                Body: `Acme: order #${order.number} is confirmed. We'll text you when it ships.`,
              }),
            },
          ),
    whatsapp: (order) =>
      call(
        "whatsapp",
        "sms",
        "twilio",
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT}/Messages.json`,
        {
          headers: twilioHeaders,
          body: new URLSearchParams({
            To: `whatsapp:${DEMO_CUSTOMER.phone}`,
            From: `whatsapp:${WHATSAPP_NUMBER}`,
            Body: `Hi ${DEMO_CUSTOMER.name}, your Acme order #${order.number} is out for delivery with ${order.courier}. It should arrive ${order.day}.`,
          }),
        },
      ),
    email: (order) =>
      call("email", "email", "resend", "https://api.resend.com/emails", {
        headers: json("re_demo"),
        body: JSON.stringify({
          from: "Acme <orders@acme.example>",
          to: [DEMO_CUSTOMER.email],
          subject: `Your receipt for order #${order.number}`,
          html: receiptHtml(order),
          text: `Thanks for your order, ${DEMO_CUSTOMER.name}! Order #${order.number}: ${order.item.name}, ${dollars(order.item.price + 6)} in total.`,
        }),
      }),
    push: async (order, fresh) => {
      await registerDevice()
      return call(
        "push",
        "push",
        "fcm",
        `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT}/messages:send`,
        {
          headers: json("fixture-token"),
          body: JSON.stringify({
            message: {
              token: DEVICE_TOKEN,
              notification: fresh
                ? {
                    title: "Your order is on its way",
                    body: `${order.courier} picked up order #${order.number}. Arriving ${order.day}.`,
                  }
                : {
                    title: "Order confirmed",
                    body: `We are packing order #${order.number}: ${order.item.name.toLowerCase()}.`,
                  },
              data: { orderId: String(order.number) },
            },
          }),
        },
      )
    },
    chat: (order, fresh) =>
      call("chat", "chat", "slack", "https://slack.com/api/chat.postMessage", {
        headers: json("xoxb-demo"),
        body: JSON.stringify({
          channel: "#orders",
          text: fresh
            ? `Order #${order.number} shipped with ${order.courier}`
            : `New order #${order.number} from ${DEMO_CUSTOMER.name}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: fresh
                  ? `:package: *Order #${order.number}* left the warehouse`
                  : `:tada: *New order #${order.number}* from ${DEMO_CUSTOMER.name}`,
              },
              fields: fresh
                ? [
                    { type: "mrkdwn", text: `*Carrier*\n${order.courier}` },
                    { type: "mrkdwn", text: `*Arrives*\n${order.day}` },
                  ]
                : [
                    { type: "mrkdwn", text: `*Item*\n${order.item.name}` },
                    { type: "mrkdwn", text: `*Total*\n${dollars(order.item.price + 6)}` },
                  ],
            },
          ],
        }),
      }),
  }

  return {
    nextOrder: () => orders++,
    send(action, order) {
      const fresh = order === undefined
      return senders[action](orderFor(order ?? orders++), fresh)
    },
    async reset() {
      registered = null
      orders = 0
      await Promise.all(
        Object.values(runtimes).map(async (runtime) => {
          const response = await runtime.fetch(
            new Request("http://emulator.local/__admin/reset", { method: "POST" }),
          )
          await response.arrayBuffer()
        }),
      )
    },
  }
}

/** The checkout scenario: what one paid order sends, and how long after the click. */
export const CHECKOUT_STEPS: readonly { action: DemoAction; afterMs: number }[] = [
  { action: "email", afterMs: 0 },
  { action: "code", afterMs: 900 },
  { action: "push", afterMs: 1800 },
  { action: "chat", afterMs: 2700 },
]
