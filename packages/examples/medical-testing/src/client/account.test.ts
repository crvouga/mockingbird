import { describe, expect, test } from "bun:test"
import { formatPhone, signInLinkToken } from "./format.js"
import { followSignInLink, onSignInLink } from "./signInLink.js"

describe("following a sign-in link in the page", () => {
  const page = "https://preview.example.test/lab/?surface=app"
  test("a link to this page is handed to the sign-in screen", () => {
    const tokens: string[] = []
    const stop = onSignInLink((token) => tokens.push(token))
    expect(followSignInLink(`${page}&sign-in=abc.def`, page)).toBe(true)
    expect(tokens).toEqual(["abc.def"])
    stop()
    expect(followSignInLink(`${page}&sign-in=abc.def`, page)).toBe(true)
    expect(tokens).toEqual(["abc.def"])
  })
  test("any other link is left to the browser", () => {
    const stop = onSignInLink(() => {
      throw new Error("not a sign-in link to this page")
    })
    expect(followSignInLink("https://elsewhere.example.test/?sign-in=abc.def", page)).toBe(false)
    expect(followSignInLink("https://preview.example.test/other?sign-in=abc.def", page)).toBe(false)
    expect(followSignInLink("https://preview.example.test/lab/?surface=app", page)).toBe(false)
    expect(followSignInLink("not a url", page)).toBe(false)
    stop()
  })
})

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
