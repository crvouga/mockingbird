import type { Preview } from "@storybook/html-vite"

/**
 * Each story draws its UI in a frame of its own (see src/frame.ts), so nothing here styles it:
 * the canvas is a bare, full-bleed page, and the viewport menu sizes the frame like a device.
 */
const preview: Preview = {
  parameters: {
    layout: "fullscreen",
    backgrounds: { disable: true },
    viewport: {
      options: {
        phone: { name: "Phone", styles: { width: "390px", height: "844px" }, type: "mobile" },
        tablet: { name: "Tablet", styles: { width: "820px", height: "1180px" }, type: "tablet" },
        laptop: { name: "Laptop", styles: { width: "1280px", height: "800px" }, type: "desktop" },
      },
    },
    options: {
      storySort: {
        order: ["Catalog", "Emulators", "Admin", "Examples", "Docs site", "Reports"],
      },
    },
  },
}

export default preview
