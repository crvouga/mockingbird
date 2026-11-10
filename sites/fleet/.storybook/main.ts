import type { StorybookConfig } from "@storybook/html-vite"

/** Every screen and state of the dashboard, drawn by the real UI over a mocked `fetch`. */
const config: StorybookConfig = {
  framework: { name: "@storybook/html-vite", options: {} },
  stories: ["../src/ui/stories/*.stories.ts"],
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
}

export default config
