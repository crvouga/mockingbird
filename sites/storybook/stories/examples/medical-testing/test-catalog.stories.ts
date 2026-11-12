import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { cove, PATIENT, type Person, person, phone, SHELL } from "./cove.js"

/** The test catalog (`Shop`): search, categories, and the order being put together. */
export default {
  title: "Examples/Medical testing/Test catalog",
  parameters: {
    layout: "fullscreen",
    sources: [...SHELL, "packages/examples/medical-testing/src/client/pages/Shop.ts"],
  },
} satisfies Meta

const catalog = (
  play?: (page: Person) => Promise<void>,
  extra: Parameters<typeof cove>[1] = {},
): StoryObj => ({
  ...cove({ as: PATIENT, route: "shop" }, extra),
  play: async ({ canvasElement }) => {
    const page = person(canvasElement)
    await page.find(".cove-test-card")
    await play?.(page)
  },
})

/** Every test, and an empty order. */
export const Catalog: StoryObj = catalog()

/** One category picked. */
export const Category: StoryObj = catalog(async (page) => {
  await page.click(".cove-categories button", "Hormones")
  await page.gone(".cove-test-card", "Lipid Panel")
})

/** A search that matches nothing. */
export const NoResults: StoryObj = catalog(async (page) => {
  await page.type('.cove-search input[type="search"]', "zinc")
  await page.find(".cove-empty", "No tests found")
})

/** Two tests in the order, the total, and the consent that unlocks checkout. */
export const OrderReady: StoryObj = catalog(async (page) => {
  await page.click(".cove-test-card:nth-child(1) button[aria-pressed]")
  await page.click(".cove-test-card:nth-child(3) button[aria-pressed]")
  await page.click(".cove-cart .cove-checkbox input")
  expect((await page.find<HTMLButtonElement>(".cove-cart .cove-btn-primary")).disabled).toBe(false)
})

/** Checkout could not start: the error, and a retry. */
export const CheckoutFailed: StoryObj = {
  ...cove({
    as: PATIENT,
    route: "shop",
    transport: (fetcher) => (path, init) =>
      path === "/api/checkout"
        ? Promise.resolve(
            Response.json({ error: "Something went wrong. Please try again." }, { status: 500 }),
          )
        : fetcher(path, init),
  }),
  play: async ({ canvasElement }) => {
    const page = person(canvasElement)
    await page.click(".cove-test-card:nth-child(1) button[aria-pressed]")
    await page.click(".cove-cart .cove-checkbox input")
    await page.click(".cove-cart .cove-btn-primary")
    await page.find('.cove-alert-error[role="alert"]', "Retry checkout")
  },
}

export const OnAPhone: StoryObj = catalog(undefined, { globals: phone })
