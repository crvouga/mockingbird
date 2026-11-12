import { ADMIN_BROWSER_BUNDLE } from "./bundle.js"
import type { AdminConfig, MembersConfig } from "./model.js"

/*
 * The only module that holds the prebuilt browser client (about 1.3 MB of JavaScript as a
 * string). A service runtime loads it with a dynamic `import()` the first time an admin page is
 * requested, so an app that never serves `/__admin/ui` never parses it, and a bundler that
 * splits code keeps it out of the main chunk. Import it statically only where the page is
 * always served.
 */

/**
 * The prebuilt browser client as a script file of its own: it defines the `MockingbirdAdmin`
 * global (`mount`, `mountMembers`) and mounts nothing. Serve it as `text/javascript`. The bundle
 * is stored escaped for inlining in a `<script>` element; this is the unescaped source.
 */
export const adminClientScript = (): string =>
  ADMIN_BROWSER_BUNDLE.replace(/<\\\/script/gi, "</script")

/** Embed the prebuilt browser client without a CDN or framework runtime dependency. */
export const adminClientSource = (config: AdminConfig): string => {
  const payload = JSON.stringify(config).replace(/</g, "\\u003c")
  return `<script>\n${ADMIN_BROWSER_BUNDLE}\nMockingbirdAdmin.mount(document.getElementById("admin-root"), ${payload});\n</script>`
}

export const membersClientSource = (config: MembersConfig): string => {
  const payload = JSON.stringify(config).replace(/</g, "\\u003c")
  return `<script>\n${ADMIN_BROWSER_BUNDLE}\nMockingbirdAdmin.mountMembers(document.getElementById("admin-root"), ${payload});\n</script>`
}
