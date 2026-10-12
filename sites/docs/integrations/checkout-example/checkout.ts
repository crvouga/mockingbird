/** The app under test: one function per vendor, every call made through the `fetch` it is given. */

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export type Keys = {
  stripe: string
  twilio: { accountSid: string; authToken: string }
  openai: string
  slack: string
  resend: string
}

export const createCheckout = ({ fetch, keys }: { fetch: Fetch; keys: Keys }) => {
  const send = async <T>(url: string, init: RequestInit): Promise<T> => {
    const response = await fetch(url, init)
    if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`)
    return (await response.json()) as T
  }
  const json = (key: string, body: unknown): RequestInit => ({
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  return {
    charge: (amount: number) =>
      send<{ id: string; status: string }>("https://api.stripe.com/v1/payment_intents", {
        method: "POST",
        headers: { authorization: `Bearer ${keys.stripe}` },
        body: new URLSearchParams({
          amount: String(amount),
          currency: "usd",
          payment_method: "pm_card_visa",
          confirm: "true",
        }),
      }),

    text: (to: string, body: string) =>
      send<{ sid: string; status: string }>(
        `https://api.twilio.com/2010-04-01/Accounts/${keys.twilio.accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            authorization: `Basic ${btoa(`${keys.twilio.accountSid}:${keys.twilio.authToken}`)}`,
          },
          body: new URLSearchParams({ To: to, From: "+12025550100", Body: body }),
        },
      ),

    summarize: async (order: string) => {
      const completion = await send<{ choices: { message: { content: string } }[] }>(
        "https://api.openai.com/v1/chat/completions",
        json(keys.openai, {
          model: "fixture-chat",
          messages: [{ role: "user", content: `Summarize ${order} in one line.` }],
        }),
      )
      return completion.choices[0]?.message.content
    },

    announce: (text: string) =>
      send<{ ok: boolean; ts: string }>(
        "https://slack.com/api/chat.postMessage",
        json(keys.slack, { channel: "#orders", text }),
      ),

    invoice: (to: string) =>
      send<{ id: string }>(
        "https://api.resend.com/emails",
        json(keys.resend, {
          from: "shop@example.com",
          to,
          subject: "Your invoice",
          html: "<p>Thanks for your order.</p>",
        }),
      ),

    // A real bucket also wants these requests signed, which the AWS SDK does for you.
    store: async (name: string, pdf: string) => {
      const url = `https://s3.us-east-1.amazonaws.com/receipts/${name}`
      const put = await fetch(url, { method: "PUT", body: pdf })
      if (!put.ok) throw new Error(`${put.status} from S3`)
      return (await fetch(url)).text()
    },
  }
}
