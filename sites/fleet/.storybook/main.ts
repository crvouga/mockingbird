import type { StorybookConfig } from "@storybook/html-vite"
import type { InlineConfig } from "vite"

/** Every screen and state of the dashboard, drawn by the real UI over a mocked `fetch`. */
const config: StorybookConfig = {
  framework: { name: "@storybook/html-vite", options: {} },
  stories: ["../src/ui/stories/*.stories.ts"],
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  viteFinal: (vite) => {
    quietBuild(vite)
    return vite
  },
}

/** kB. Storybook's own runtime and the dashboard are each most of a megabyte. */
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
