import type { StorybookConfig } from "@storybook/html-vite"

/** Every state of the harness UI, drawn from fixtures. `bun run catalog:screenshots` photographs them. */
const config: StorybookConfig = {
  framework: "@storybook/html-vite",
  stories: ["../stories/**/*.stories.ts"],
  core: { disableTelemetry: true },
}

export default config
