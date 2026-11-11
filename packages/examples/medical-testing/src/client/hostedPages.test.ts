import { describe, expect, test } from "bun:test"
import { formatCardExpiry, formatCardNumber } from "./hostedPages.js"

describe("hosted checkout card fields", () => {
  test("a card number is grouped the way its brand prints it", () => {
    expect(formatCardNumber("4242424242424242")).toEqual({
      text: "4242 4242 4242 4242",
      brand: "visa",
    })
    expect(formatCardNumber("378282246310005")).toEqual({
      text: "3782 822463 10005",
      brand: "amex",
    })
    expect(formatCardNumber("5555-5555 5555 4444").brand).toBe("mastercard")
    expect(formatCardNumber("6011111111111117").brand).toBe("discover")
    expect(formatCardNumber("42x42")).toEqual({ text: "4242", brand: "visa" })
    expect(formatCardNumber("")).toEqual({ text: "", brand: "" })
  })

  test("an expiry gains its separator while typing and loses it while deleting", () => {
    expect(formatCardExpiry("1")).toBe("1")
    expect(formatCardExpiry("5")).toBe("05 / ")
    expect(formatCardExpiry("12")).toBe("12 / ")
    expect(formatCardExpiry("12", true)).toBe("12")
    expect(formatCardExpiry("1234")).toBe("12 / 34")
    expect(formatCardExpiry("12 / 345")).toBe("12 / 34")
  })
})
