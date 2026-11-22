import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { cove, PATIENT, type Person, person, phone, SHELL } from "./cove.js"

/** The test catalog (`Shop`): search, categories, and the order being put together. */
export default {
  title: "Examples/Medical testing/Test catalog",
  parameters: {
    layout: "fullscreen",
    sources: [...SHELL, "packages/examples/medical-testing/src/client/pages/Shop.tsx"],
  },
} satisfies Meta

const catalog = (
  play?: (page: Person) => Promise<void>,
  extra: Parameters<typeof cove>[1] = {},
): StoryObj => ({
  ...cove({ as: PATIENT, route: "shop" }, extra),
  play: async ({ canvasElement }) => {
    const page = person(canvasElement)
    await page.find('[data-testid="test-row"]')
    await play?.(page)
  },
})

/** Every test, and an empty order. */
export const Catalog: StoryObj = catalog()

/** One category picked. */
export const Category: StoryObj = catalog(async (page) => {
  await page.click('[data-testid="category"]', "Hormones")
  await page.gone('[data-testid="test-row"]', "Lipid Panel")
})

/** A search that matches nothing. */
export const NoResults: StoryObj = catalog(async (page) => {
  await page.type('[data-testid="catalog-search"]', "zinc")
  await page.find('[data-testid="catalog-empty"]', "No tests found")
})

/** Two tests in the order, the total, and the consent that unlocks checkout. */
export const OrderReady: StoryObj = catalog(async (page) => {
  await page.click('[data-testid="test-row"]:nth-child(1) [data-testid="add-test"]')
  await page.click('[data-testid="test-row"]:nth-child(3) [data-testid="add-test"]')
  await page.click('[data-testid="order-consent"]')
  expect((await page.find<HTMLButtonElement>('[data-testid="checkout-continue"]')).disabled).toBe(
    false,
  )
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
    await page.click('[data-testid="test-row"]:nth-child(1) [data-testid="add-test"]')
    await page.click('[data-testid="order-consent"]')
    await page.click('[data-testid="checkout-continue"]')
    await page.find('[data-testid="checkout-error"]', "Retry checkout")
  },
}

export const OnAPhone: StoryObj = catalog(undefined, { globals: phone })
