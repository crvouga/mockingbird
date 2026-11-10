import type { Preview } from "@storybook/html-vite"
import { PAGE_STYLES, STYLES } from "../src/ui/styles.js"

const style = document.createElement("style")
style.textContent = PAGE_STYLES + STYLES
document.head.append(style)

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    backgrounds: { disable: true },
  },
}

export default preview
