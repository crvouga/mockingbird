import { defineConfig } from "astro/config";

export default defineConfig({
  outDir: "./dist",
  publicDir: "./public",
  trailingSlash: "never",
  site: "https://mockingbird.dev",
});
