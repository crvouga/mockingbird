import type { StorybookConfig } from "@storybook/html-vite"
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
    : ["../stories/**/*.mdx", "../stories/**/*.stories.ts"],
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  refs: (_config, { configType }) =>
    configType === "DEVELOPMENT"
      ? {
          fleet: { title: "Fleet Cloud dashboard", url: "http://localhost:6006" },
          notifications: { title: "Notifications harness", url: "http://localhost:6007" },
        }
      : {
          fleet: { title: "Fleet Cloud dashboard", url: "./fleet" },
          notifications: { title: "Notifications harness", url: "./notifications" },
        },
  viteFinal: (vite) => {
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

export default config
