import { describe, expect, test } from "bun:test"
import { formatPhone } from "./pages/Account.js"
import { signInLinkToken } from "./pages/Landing.js"

describe("sign-in link", () => {
  test("the token is read from a pasted link or a page address", () => {
    expect(signInLinkToken("http://localhost:4300/?sign-in=abc-123.def456")).toBe("abc-123.def456")
    expect(signInLinkToken("?utm=x&sign-in=abc.def")).toBe("abc.def")
  })
  test("a six-digit code is not mistaken for a link", () => {
    expect(signInLinkToken("123456")).toBeNull()
    expect(signInLinkToken("")).toBeNull()
  })
})

describe("phone display", () => {
  test("US numbers read the way people write them", () => {
    expect(formatPhone("+14155550142")).toBe("(415) 555-0142")
  })
  test("other numbers are shown as stored", () => {
    expect(formatPhone("+442079460000")).toBe("+442079460000")
  })
})
