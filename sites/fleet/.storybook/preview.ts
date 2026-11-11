import type { Preview } from "@storybook/html-vite"
import "../src/ui/app.css"

const preview: Preview = {
  parameters: {
    // The dashboard is a whole page, and brings its own light and dark colours.
    layout: "fullscreen",
    backgrounds: { disable: true },
    options: {
      storySort: {
        order: [
          "Shell",
          "Sign in",
          "Organizations",
          "Organization",
          ["Projects", "Members", "Usage", "API keys", "Audit log", "Settings"],
          "Project",
          "Fleet",
          "Account",
          "API reference",
          "Invite",
          "Errors",
        ],
      },
    },
  },
}

export default preview
