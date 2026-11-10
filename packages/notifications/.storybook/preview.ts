import type { Preview } from "@storybook/html-vite"
import { STYLES } from "../src/ui/styles.js"

const style = document.createElement("style")
style.textContent = STYLES
document.head.append(style)

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    backgrounds: { disable: true },
  },
}

export default preview
