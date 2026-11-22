import type { StorybookConfig } from "@storybook/html-vite"
import type { InlineConfig } from "vite"

/** Every state of the harness UI, drawn from fixtures. `bun run catalog:screenshots` photographs them. */
const config: StorybookConfig = {
  framework: "@storybook/html-vite",
  stories: ["../stories/**/*.stories.ts"],
  core: { disableTelemetry: true },
  viteFinal: (vite) => {
    quietBuild(vite)
    return vite
  },
}

/** kB. Storybook's own runtime and the harness are each around a megabyte. */
const CHUNK_LIMIT = 2_000

/**
 * HeroUI marks every component file `"use client"`, which means nothing in a browser bundle;
 * Rolldown says so once per file.
 */
function quietBuild(vite: InlineConfig): void {
  vite.build ??= {}
  vite.build.chunkSizeWarningLimit = CHUNK_LIMIT
  vite.build.rolldownOptions ??= {}
  vite.build.rolldownOptions.onwarn = (warning, warn) => {
    if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning)
  }
}

export default config
