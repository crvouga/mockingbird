import type { StorybookConfig } from "@storybook/html-vite"
import type { InlineConfig } from "vite"
import { REPO_ROOT, sourceEntries } from "./workspace.js"

/**
 * The UI catalog. Its own stories live in `stories/`; the Fleet Cloud dashboard and the
 * notifications harness keep their own Storybooks (each styles the whole page) and are composed
 * in as refs: side by side under `storybook dev`, and copied into `fleet/` and `notifications/`
 * next to this one by `bun run build`.
 */
const config: StorybookConfig = {
  framework: { name: "@storybook/html-vite", options: {} },
  // `STORIES=../stories/emulators/stripe/**/*.stories.ts` builds a slice of the catalog.
  stories: process.env.STORIES
    ? process.env.STORIES.split(/,(?![^{]*\})/)
    : ["../stories/**/*.stories.ts"],
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  refs: (_config, { configType }) =>
    configType === "DEVELOPMENT"
      ? {
          // `scripts/dev.ts` says where it started them; the ports move when the usual are taken.
          fleet: {
            title: "Fleet Cloud dashboard",
            url: process.env.STORYBOOK_FLEET_URL ?? "http://localhost:6006",
          },
          notifications: {
            title: "Notifications harness",
            url: process.env.STORYBOOK_NOTIFICATIONS_URL ?? "http://localhost:6007",
          },
        }
      : {
          fleet: { title: "Fleet Cloud dashboard", url: "./fleet" },
          notifications: { title: "Notifications harness", url: "./notifications" },
        },
  viteFinal: (vite) => {
    quietBuild(vite)
    const entries = sourceEntries()
    vite.resolve ??= {}
    vite.resolve.alias = [
      ...Object.entries(entries).map(([find, replacement]) => ({
        find: new RegExp(`^${find.replace(/[/-]/g, "\\$&")}$`),
        replacement,
      })),
      ...(Array.isArray(vite.resolve.alias) ? vite.resolve.alias : []),
    ]
    vite.server ??= {}
    vite.server.fs = { ...vite.server.fs, allow: [REPO_ROOT] }
    return vite
  },
}

/** kB. An emulator chunk can carry a recorded corpus; the docs site allows the same. */
const CHUNK_LIMIT = 20_000

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
