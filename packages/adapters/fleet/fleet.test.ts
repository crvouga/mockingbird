import { expect, test } from "bun:test"
import {
  createInstalledServiceLoader,
  FleetClient,
  startFleet,
  validateArchive,
} from "./src/index.js"

test("vendor-neutral exports retain fleet lifecycle and extension contracts", () => {
  expect(
    [createInstalledServiceLoader, FleetClient, startFleet, validateArchive].every(
      (fn) => typeof fn === "function",
    ),
  ).toBe(true)
})
