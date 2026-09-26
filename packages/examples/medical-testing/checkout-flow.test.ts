import { describe, expect, test } from "bun:test"
import { buildApp } from "./src/composition/build.js"

/**
 * Exercises the same buy → pay → fulfill cycle a real visitor drives through
 * the UI, but against `app.request()` directly (no socket), so it runs fast
 * and needs no port. Every step goes through the app's real HTTP surface —
 * no admin/test-only shortcuts — including a real, form-driven OAuth sign-in
 * and a real, form-driven hosted-checkout payment.
 */
const setup = async () => {
  const app = await buildApp({ html: "<html></html>", js: "" })
  return { app, cookie: { value: "" } }
}

const request = async (
  app: Awaited<ReturnType<typeof setup>>["app"],
  cookieBox: { value: string },
  path: string,
  init?: RequestInit,
) => {
  const response = await app.request(path, {
    ...init,
    headers: { "content-type": "application/json", cookie: cookieBox.value, ...init?.headers },
  })
  const setCookie = response.headers.get("set-cookie")
  if (setCookie) cookieBox.value = setCookie.split(";")[0] ?? cookieBox.value
  return response
}

type ParsedForm = {
  method: string
  action: string
  fields: Record<string, string>
  submitters: { name: string; value: string }[]
}

const decodeEntities = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

/** Parses a hosted page's real server-rendered HTML `<form>`s — the production counterpart to
 * this is `src/client/components/hostedFrame.ts`'s DOM-based form interception. A form with no
 * `action` attribute (the hosted checkout page's form) submits to its own URL — see the caller. */
const extractForms = (html: string): ParsedForm[] => {
  const forms: ParsedForm[] = []
  for (const match of html.matchAll(
    /<form\s+method="([^"]+)"(?:\s+action="([^"]*)")?[^>]*>([\s\S]*?)<\/form>/gi,
  )) {
    const [, method, action, inner] = match
    if (!method || inner === undefined) continue
    const fields: Record<string, string> = {}
    for (const field of inner.matchAll(/<input[^>]*\bname="([^"]+)"[^>]*\bvalue="([^"]*)"/gi))
      fields[field[1] as string] = decodeEntities(field[2] as string)
    const submitters: { name: string; value: string }[] = []
    for (const btn of inner.matchAll(/<button[^>]*\bname="([^"]+)"[^>]*\bvalue="([^"]+)"/gi))
      submitters.push({ name: btn[1] as string, value: decodeEntities(btn[2] as string) })
    forms.push({ method, action: action ?? "", fields, submitters })
  }
  return forms
}

/**
 * Drives a real, complete Google sign-in through this app's own
 * `/api/auth/google/{start,step}` endpoints — discovery, PKCE, the account
 * chooser, consent, token exchange, and userinfo — exactly the protocol
 * dance the client's OAuthModal drives by intercepting form submits, minus
 * the DOM (we parse the same real HTML with regex instead of a browser).
 */
const signInWithGoogle = async (
  app: Awaited<ReturnType<typeof setup>>["app"],
  cookie: { value: string },
): Promise<void> => {
  const start = await request(app, cookie, "/api/auth/google/start", { method: "POST" })
  expect(start.status).toBe(200)
  const startBody = (await start.json()) as { flowId: string; html: string }

  const chooserForms = extractForms(startBody.html)
  const selectForm = chooserForms.find((form) => form.submitters.some((s) => s.name === "account"))
  if (!selectForm) throw new Error("No account-select form in the chooser page")
  const accountSubmitter = selectForm.submitters.find((s) => s.name === "account")
  if (!accountSubmitter) throw new Error("No account submitter")

  const selectStep = await request(app, cookie, "/api/auth/google/step", {
    method: "POST",
    body: JSON.stringify({
      flowId: startBody.flowId,
      action: selectForm.action,
      method: selectForm.method,
      body: new URLSearchParams({
        ...selectForm.fields,
        [accountSubmitter.name]: accountSubmitter.value,
      }).toString(),
    }),
  })
  expect(selectStep.status).toBe(200)
  const selectBody = (await selectStep.json()) as { flowId: string; html: string }

  const consentForms = extractForms(selectBody.html)
  const allowForm = consentForms.find((form) => form.submitters.some((s) => s.value === "allow"))
  if (!allowForm) throw new Error("No consent form with an allow submitter")
  const allowSubmitter = allowForm.submitters.find((s) => s.value === "allow")
  if (!allowSubmitter) throw new Error("No allow submitter")

  const allowStep = await request(app, cookie, "/api/auth/google/step", {
    method: "POST",
    body: JSON.stringify({
      flowId: selectBody.flowId,
      action: allowForm.action,
      method: allowForm.method,
      body: new URLSearchParams({
        ...allowForm.fields,
        [allowSubmitter.name]: allowSubmitter.value,
      }).toString(),
    }),
  })
  expect(allowStep.status).toBe(200)
  const allowBody = (await allowStep.json()) as { user?: { email: string | null } }
  expect(allowBody.user?.email).toBe("ada@example.test")
}

/**
 * Drives a real hosted-checkout payment: opens the checkout session's real
 * hosted page and submits its real card form — no admin/test-only bypass —
 * the production counterpart to this is `src/client/components/CheckoutModal.ts`.
 */
const payWithHostedCheckout = async (
  app: Awaited<ReturnType<typeof setup>>["app"],
  cookie: { value: string },
  checkoutSessionId: string,
): Promise<void> => {
  const start = await request(app, cookie, "/api/checkout/hosted/start", {
    method: "POST",
    body: JSON.stringify({ checkoutSessionId }),
  })
  expect(start.status).toBe(200)
  const startBody = (await start.json()) as { flowId: string; html: string }

  const forms = extractForms(startBody.html)
  const payForm = forms.find((form) => form.submitters.some((s) => s.value === "pay"))
  if (!payForm) throw new Error("No payment form on the hosted checkout page")
  const paySubmitter = payForm.submitters.find((s) => s.value === "pay")
  if (!paySubmitter) throw new Error("No pay submitter")

  const step = await request(app, cookie, "/api/checkout/hosted/step", {
    method: "POST",
    body: JSON.stringify({
      flowId: startBody.flowId,
      action: payForm.action,
      method: payForm.method,
      body: new URLSearchParams({
        ...payForm.fields,
        [paySubmitter.name]: paySubmitter.value,
        card: "4242424242424242",
      }).toString(),
    }),
  })
  expect(step.status).toBe(200)
  const stepBody = (await step.json()) as { done?: boolean }
  expect(stepBody.done).toBe(true)
}

const waitUntil = async (predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Timed out waiting for condition")
}

describe("Cove checkout flow", () => {
  test("buying a test pays, fulfills, and settles into results on its own", async () => {
    const { app, cookie } = await setup()
    await signInWithGoogle(app, cookie)

    const testsResponse = await request(app, cookie, "/api/tests")
    const { tests } = (await testsResponse.json()) as { tests: { id: string }[] }
    expect(tests.length).toBeGreaterThan(0)
    const testId = tests[0]?.id
    if (!testId) throw new Error("no lab tests seeded")

    const checkoutResponse = await request(app, cookie, "/api/checkout", {
      method: "POST",
      body: JSON.stringify({ testIds: [testId] }),
    })
    expect(checkoutResponse.status).toBe(200)
    const { orderId, checkoutSessionId } = (await checkoutResponse.json()) as {
      orderId: string
      checkoutSessionId: string
    }

    await payWithHostedCheckout(app, cookie, checkoutSessionId)

    await waitUntil(async () => {
      const body = (await (await request(app, cookie, "/api/orders")).json()) as {
        orders: { id: string; status: string; labOrderId: string | null }[]
      }
      const order = body.orders.find((o) => o.id === orderId)
      return order?.status === "fulfilled" && Boolean(order.labOrderId)
    })

    // No manual "advance" step — the lab-testing adapter progresses the
    // order on its own timer and delivers a webhook when results land.
    await waitUntil(async () => {
      const body = (await (await request(app, cookie, "/api/orders")).json()) as {
        orders: { id: string; status: string; interpretation: string | null }[]
      }
      const order = body.orders.find((o) => o.id === orderId)
      return order?.status === "results_ready" && Boolean(order.interpretation)
    }, 8_000)
    // The lab adapter holds results for RESULTS_READY_DELAY_MS (4s), so bun's 5s default
    // leaves no room; budget for both waitUntil calls instead.
  }, 15_000)

  test("checkout requires signing in first", async () => {
    const { app, cookie } = await setup()
    const response = await request(app, cookie, "/api/checkout", {
      method: "POST",
      body: JSON.stringify({ testIds: [] }),
    })
    expect(response.status).toBe(401)
  })
})
