import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import type { Preview } from "@storybook/html-vite"
import { STYLES } from "../src/ui/skins.js"

// What the harness page carries: Mockingbird's stylesheet and the device skins.
const style = document.createElement("style")
style.textContent = MOCKINGBIRD_CSS + STYLES
document.head.append(style)

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    backgrounds: { disable: true },
  },
  globalTypes: {
    theme: {
      description: "Light or dark, as Mockingbird's theme switch sets it",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: [
          { value: "system", title: "System" },
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "system" },
  decorators: [
    (story, context) => {
      const theme = context.globals.theme as string | undefined
      const html = document.documentElement
      html.classList.remove("light", "dark")
      html.removeAttribute("data-theme")
      if (theme === "light" || theme === "dark") {
        html.classList.add(theme)
        html.setAttribute("data-theme", theme)
      }
      return story()
    },
  ],
}

export default preview
