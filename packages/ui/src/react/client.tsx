/**
 * The browser side of a Mockingbird React page. A client entry (bundled with
 * packages/ui/scripts/bundle.ts) exports a function that calls `mount`:
 *
 *   export function mountConsent(root: HTMLElement, props: ConsentProps) {
 *     mount(root, <Consent {...props} />)
 *   }
 */
import type { ReactNode } from "react"
import { createRoot, hydrateRoot, type Root } from "react-dom/client"
import { MockingbirdProvider, type MockingbirdProviderProps } from "./provider.js"

export type MountOptions = Omit<MockingbirdProviderProps, "children">

/**
 * Render `element` into `container`, inside `MockingbirdProvider`. When the container is the root
 * of a server-rendered page (`renderPage`'s `[data-mockingbird-root]`) and already holds its
 * markup, it is hydrated instead, so the page keeps what the server drew and becomes interactive;
 * pass the same element (same props) the server rendered. Any other container is rendered into
 * fresh, whatever it holds, so markup that React did not draw is never hydrated.
 */
export function mount(container: Element, element: ReactNode, options: MountOptions = {}): Root {
  const tree = <MockingbirdProvider {...options}>{element}</MockingbirdProvider>
  if (container.hasAttribute("data-mockingbird-root") && container.firstElementChild)
    return hydrateRoot(container, tree)
  const root = createRoot(container)
  root.render(tree)
  return root
}
