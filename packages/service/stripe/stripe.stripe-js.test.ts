import { describe, expect, test } from "bun:test"
import { CARD_CORE } from "./src/card-input.js"
import { stripeJs } from "./src/stripe-js.js"

class FakeElement {
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []
  readonly listeners = new Map<string, Array<() => void>>()
  name = ""
  parentNode: FakeElement | null = null
  placeholder = ""
  textContent = ""
  value = ""

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }

  appendChild(child: FakeElement) {
    child.parentNode = this
    this.children.push(child)
  }

  removeChild(child: FakeElement) {
    this.children.splice(this.children.indexOf(child), 1)
    child.parentNode = null
  }

  addEventListener(name: string, listener: () => void) {
    const listeners = this.listeners.get(name) ?? []
    listeners.push(listener)
    this.listeners.set(name, listeners)
  }

  dispatch(name: string) {
    for (const listener of this.listeners.get(name) ?? []) listener()
  }

  focus() {
    this.dispatch("focus")
  }

  blur() {
    this.dispatch("blur")
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches = (element: FakeElement) => {
      const name = selector.match(/^\[name="(.+)"\]$/)?.[1]
      if (name) return element.name === name
      const testId = selector.match(/^\[data-testid="(.+)"\]$/)?.[1]
      if (testId) return element.attributes.get("data-testid") === testId
      return element.tagName === selector
    }
    return this.children.flatMap((child) => [
      ...(matches(child) ? [child] : []),
      ...child.querySelectorAll(selector),
    ])
  }
}

const loadStripeJs = () => {
  const hosts = new Map<string, FakeElement>()
  const document = {
    createElement: (tagName: string) => new FakeElement(tagName),
    querySelector: (selector: string) => hosts.get(selector) ?? null,
  }
  const window = {} as Record<string, unknown>
  new Function("window", "document", stripeJs("http://stripe.test"))(window, document)
  return {
    host(selector: string) {
      const host = new FakeElement("div")
      hosts.set(selector, host)
      return host
    },
    Stripe: window.Stripe as (key: string) => {
      elements: (options?: Record<string, unknown>) => {
        submit: () => Promise<{ error?: { code: string } }>
        create: (
          type: string,
          options?: Record<string, unknown>,
        ) => {
          mount: (selector: string) => void
          card: () => { number: string; exp_month: number; exp_year: number; cvc: string }
          on: (name: string, handler: (event: Record<string, unknown>) => void) => void
          update: (options: Record<string, unknown>) => void
          focus: () => void
          blur: () => void
          clear: () => void
        }
      }
      createToken: (element: unknown) => Promise<{
        error?: { code: string }
        token?: { id: string }
      }>
    },
  }
}

const inputOf = (host: FakeElement, name: string) => {
  const input = host.querySelector(`[name="${name}"]`)
  if (!input) throw new Error(`input ${name} did not mount`)
  return input
}

const enter = (input: FakeElement, value: string) => {
  input.value = value
  input.dispatch("input")
}

describe("Stripe.js card Elements", () => {
  test("split Elements render one unlabeled semantic control each", () => {
    const browser = loadStripeJs()
    const elements = browser.Stripe("pk_test_mockingbird").elements()

    for (const [type, name, testId] of [
      ["cardNumber", "card", "stripe-mock-card"],
      ["cardExpiry", "exp", "stripe-mock-exp"],
      ["cardCvc", "cvc", "stripe-mock-cvc"],
    ] as const) {
      const selector = `#${type}`
      const host = browser.host(selector)
      elements.create(type).mount(selector)

      expect(host.querySelectorAll("input")).toHaveLength(1)
      expect(host.querySelector(`[name="${name}"]`)).not.toBeNull()
      expect(host.querySelector(`[data-testid="${testId}"]`)).not.toBeNull()
      expect(host.querySelectorAll("label")).toHaveLength(0)
    }
  })

  test("the combined card Element renders card details once and honors hidePostalCode", () => {
    const browser = loadStripeJs()
    const elements = browser.Stripe("pk_test_mockingbird").elements()
    const shown = browser.host("#shown")
    const hidden = browser.host("#hidden")

    elements.create("card").mount("#shown")
    elements.create("card", { hidePostalCode: true }).mount("#hidden")

    expect(shown.querySelectorAll("input").map((input) => input.name)).toEqual([
      "card",
      "exp",
      "cvc",
      "zip",
    ])
    expect(hidden.querySelectorAll("input").map((input) => input.name)).toEqual([
      "card",
      "exp",
      "cvc",
    ])
  })

  test("the cardNumber Element tokenizes values from sibling split Elements", () => {
    const browser = loadStripeJs()
    const elements = browser.Stripe("pk_test_mockingbird").elements()
    const numberHost = browser.host("#number")
    const expiryHost = browser.host("#expiry")
    const cvcHost = browser.host("#cvc")
    const number = elements.create("cardNumber")
    number.mount("#number")
    elements.create("cardExpiry").mount("#expiry")
    elements.create("cardCvc").mount("#cvc")

    const numberInput = numberHost.querySelector('[name="card"]')
    const expiryInput = expiryHost.querySelector('[name="exp"]')
    const cvcInput = cvcHost.querySelector('[name="cvc"]')
    if (!numberInput || !expiryInput || !cvcInput) throw new Error("split inputs did not mount")
    numberInput.value = "4242 4242 4242 4242"
    expiryInput.value = "09/35"
    cvcInput.value = "987"

    expect(number.card()).toEqual({
      number: "4242424242424242",
      exp_month: 9,
      exp_year: 2035,
      cvc: "987",
    })
  })

  test("change events track empty, complete, errors, formatting, and card brand", () => {
    const browser = loadStripeJs()
    const elements = browser.Stripe("pk_test_mockingbird").elements()
    const host = browser.host("#number")
    const number = elements.create("cardNumber")
    const changes: Array<Record<string, unknown>> = []
    number.on("change", (event) => changes.push(event))
    number.mount("#number")
    const input = inputOf(host, "card")

    enter(input, "4")
    expect(changes.at(-1)).toMatchObject({
      brand: "visa",
      complete: false,
      empty: false,
      error: { code: "incomplete_number" },
    })

    enter(input, "4242424242424242")
    expect(input.value).toBe("4242 4242 4242 4242")
    expect(changes.at(-1)).toMatchObject({ brand: "visa", complete: true, empty: false })
    expect(changes.at(-1)).not.toHaveProperty("error")

    enter(input, "5555555555554444")
    expect(changes.at(-1)).toMatchObject({ brand: "mastercard", complete: true })

    number.clear()
    expect(input.value).toBe("")
    expect(changes.at(-1)).toMatchObject({
      brand: "unknown",
      complete: false,
      empty: true,
      error: { code: "incomplete_number" },
    })
  })

  test("expiry and CVC inputs format and validate according to the card brand", () => {
    const browser = loadStripeJs()
    const elements = browser.Stripe("pk_test_mockingbird").elements()
    const numberHost = browser.host("#number")
    const expiryHost = browser.host("#expiry")
    const cvcHost = browser.host("#cvc")
    elements.create("cardNumber").mount("#number")
    const expiry = elements.create("cardExpiry")
    expiry.mount("#expiry")
    const cvc = elements.create("cardCvc")
    cvc.mount("#cvc")
    const expiryChanges: Array<Record<string, unknown>> = []
    const cvcChanges: Array<Record<string, unknown>> = []
    expiry.on("change", (event) => expiryChanges.push(event))
    cvc.on("change", (event) => cvcChanges.push(event))

    enter(inputOf(expiryHost, "exp"), "1299")
    expect(inputOf(expiryHost, "exp").value).toBe("12 / 99")
    expect(expiryChanges.at(-1)).toMatchObject({ complete: true, empty: false })

    enter(inputOf(numberHost, "card"), "4242424242424242")
    enter(inputOf(cvcHost, "cvc"), "1234")
    expect(inputOf(cvcHost, "cvc").value).toBe("123")
    expect(cvcChanges.at(-1)).toMatchObject({ complete: true })

    enter(inputOf(numberHost, "card"), "378282246310005")
    enter(inputOf(cvcHost, "cvc"), "123")
    expect(cvcChanges.at(-1)).toMatchObject({
      complete: false,
      error: { code: "incomplete_cvc" },
    })
    enter(inputOf(cvcHost, "cvc"), "1234")
    expect(cvcChanges.at(-1)).toMatchObject({ complete: true })
  })

  test("createToken rejects missing and invalid split values without substituting defaults", async () => {
    const browser = loadStripeJs()
    const stripe = browser.Stripe("pk_test_mockingbird")
    const elements = stripe.elements()
    const numberHost = browser.host("#number")
    const expiryHost = browser.host("#expiry")
    const cvcHost = browser.host("#cvc")
    const number = elements.create("cardNumber")
    number.mount("#number")
    elements.create("cardExpiry").mount("#expiry")
    elements.create("cardCvc").mount("#cvc")

    expect(await stripe.createToken(number)).toMatchObject({ error: { code: "incomplete_number" } })
    enter(inputOf(numberHost, "card"), "4242424242424241")
    expect(await stripe.createToken(number)).toMatchObject({ error: { code: "invalid_number" } })
    enter(inputOf(numberHost, "card"), "4242424242424242")
    enter(inputOf(expiryHost, "exp"), "0120")
    enter(inputOf(cvcHost, "cvc"), "123")
    expect(await stripe.createToken(number)).toMatchObject({
      error: { code: "invalid_expiry_year_past" },
    })
    enter(inputOf(expiryHost, "exp"), "1299")
    enter(inputOf(cvcHost, "cvc"), "12")
    expect(await stripe.createToken(number)).toMatchObject({ error: { code: "incomplete_cvc" } })
    enter(inputOf(cvcHost, "cvc"), "123")
    expect(await stripe.createToken(number)).toMatchObject({ token: { id: "tok_visa" } })
  })

  test("focus, blur, clear, and update keep Element state events coherent", () => {
    const browser = loadStripeJs()
    const elements = browser.Stripe("pk_test_mockingbird").elements()
    const host = browser.host("#number")
    const number = elements.create("cardNumber")
    const events: string[] = []
    number.on("focus", () => events.push("focus"))
    number.on("blur", () => events.push("blur"))
    number.on("change", (event) => events.push(`change:${event.empty}`))
    number.mount("#number")

    number.focus()
    number.blur()
    enter(inputOf(host, "card"), "4242424242424242")
    number.update({})
    number.clear()

    expect(events).toEqual(["focus", "blur", "change:false", "change:false", "change:true"])
  })
})

type Core = {
  format: (name: string, value: string, ctx?: Record<string, unknown>) => string
  validate: (name: string, value: string, ctx?: Record<string, unknown>) => { code: string } | null
}
const core = new Function(`${CARD_CORE}; return MBCard;`)() as Core

describe("shared card-field core", () => {
  test("masks numbers per brand, expiry as MM / YY, and CVC per brand", () => {
    expect(core.format("card", "4242424242424242424242424242")).toBe("4242 4242 4242 4242")
    expect(core.format("card", "378282246310005")).toBe("3782 822463 10005")
    expect(core.format("exp", "4")).toBe("04 / ")
    expect(core.format("exp", "13")).toBe("01 / 3")
    expect(core.format("exp", "12", { deleting: true })).toBe("12")
    expect(core.format("exp", "12/345")).toBe("12 / 34")
    expect(core.format("cvc", "12345", { brand: "amex" })).toBe("1234")
    expect(core.format("cvc", "12345", { brand: "visa" })).toBe("123")
  })

  test("validates with Stripe's codes", () => {
    expect(core.validate("card", "4242 4242 4242 4242")).toBeNull()
    expect(core.validate("card", "4242 4242")?.code).toBe("incomplete_number")
    expect(core.validate("card", "4242 4242 4242 4241")?.code).toBe("invalid_number")
    expect(core.validate("exp", "13 / 30")?.code).toBe("invalid_expiry_month")
    expect(core.validate("zip", "941", { country: "US" })?.code).toBe("incomplete_zip")
    expect(core.validate("zip", "SW1A 1AA", { country: "GB" })).toBeNull()
  })
})

describe("Stripe.js Payment Element", () => {
  test("renders labelled card and billing fields themed by the Appearance API", () => {
    const browser = loadStripeJs()
    const host = browser.host("#payment")
    browser
      .Stripe("pk_test_mockingbird")
      .elements({
        appearance: {
          theme: "night",
          variables: { colorPrimary: "#ff0066" },
          rules: { ".Input:focus": { borderColor: "#ff0066" } },
        },
      })
      .create("payment")
      .mount("#payment")

    expect(host.querySelectorAll("input").map((input) => input.name)).toEqual([
      "card",
      "exp",
      "cvc",
      "zip",
    ])
    expect(host.querySelector('[name="country"]')?.value).toBe("US")
    const css = host.querySelectorAll("style")[0]?.textContent ?? ""
    expect(css).toContain("--colorPrimary:#ff0066")
    expect(css).toContain("--colorBackground:#30313d")
    expect(css).toMatch(/\.mb-Input:focus\{border-color:#ff0066\}/)
  })

  test("elements.submit() reports the first invalid field and reveals every error", async () => {
    const browser = loadStripeJs()
    const host = browser.host("#payment")
    const elements = browser.Stripe("pk_test_mockingbird").elements()
    elements.create("payment").mount("#payment")

    expect(await elements.submit()).toMatchObject({ error: { code: "incomplete_number" } })
    const shown = host
      .querySelectorAll("div")
      .filter((node) => (node.attributes.get("class") ?? "").split(" ").includes("mb-Error"))
      .map((node) => node.textContent)
      .filter(Boolean)
    expect(shown).toContain("Your card number is incomplete.")

    enter(inputOf(host, "card"), "4242424242424242")
    enter(inputOf(host, "exp"), "1234")
    enter(inputOf(host, "cvc"), "123")
    enter(inputOf(host, "zip"), "94107")
    expect(await elements.submit()).toEqual({})
  })
})
