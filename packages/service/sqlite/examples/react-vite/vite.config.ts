import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dir = path.dirname(fileURLToPath(import.meta.url));
// The shared design system (@crvouga/mockingbird-ui), read from the repo source like the library.
const ui = path.resolve(dir, "../../../../ui");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@crvouga/mockingbird-service-sqlite": path.resolve(dir, "../../src/index.ts"),
      "@crvouga/mockingbird-ui/react/client": path.join(ui, "src/react/client.tsx"),
      "@crvouga/mockingbird-ui/react": path.join(ui, "src/react/index.ts"),
      "@crvouga/mockingbird-ui/theme.css": path.join(ui, "src/theme.css"),
    },
    // The shared components import React and HeroUI too: resolve them all from this example, so
    // the page has one copy of each.
    dedupe: ["react", "react-dom", "@heroui/react", "@heroui/styles", "@gravity-ui/icons"],
  },
  server: { fs: { allow: [path.resolve(dir, "../.."), ui] } },
});
