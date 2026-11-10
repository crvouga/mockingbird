import { defineConfig } from "@playwright/test"
import { defineBddConfig } from "playwright-bdd"

/**
 * The Gherkin features in `specs/features` are the source of truth for behaviour. `bddgen` turns
 * them into Playwright tests; steps live in `specs/steps`. Set SPEC_FEATURES to run a subset and
 * SPEC_RUN to give concurrent runs separate working directories.
 */
const run = process.env.SPEC_RUN ?? "all"
const testDir = defineBddConfig({
  features: process.env.SPEC_FEATURES ?? "specs/features/**/*.feature",
  // SPEC_STEPS narrows step loading to some files (comma-separated globs) while an area is in progress.
  steps: process.env.SPEC_STEPS?.split(",") ?? ["specs/steps/**/*.ts", "specs/support/fixtures.ts"],
  outputDir: `.spec-run/${run}/generated`,
})

export default defineConfig({
  testDir,
  // The server serves the dashboard from dist/public, so it is built once before any scenario.
  globalSetup: "./specs/support/global-setup.ts",
  outputDir: `.spec-run/${run}/results`,
  fullyParallel: true,
  workers: Number(process.env.SPEC_WORKERS ?? 2),
  timeout: 60_000,
  retries: 0,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
})
