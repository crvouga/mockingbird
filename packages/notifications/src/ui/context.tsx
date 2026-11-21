import { createContext, type ReactNode, use } from "react"
import type { Notification } from "../model.js"
import { notificationAttrs } from "./format.js"
import type { Store } from "./store.js"

const StoreContext = createContext<Store | null>(null)

export function StoreProvider({ store, children }: { store: Store; children: ReactNode }) {
  return <StoreContext value={store}>{children}</StoreContext>
}

/** The harness UI's store. Every component under `NotificationsApp` reads it. */
export function useStore(): Store {
  const store = use(StoreContext)
  if (!store) throw new Error("useStore: no StoreProvider")
  return store
}

/** One of the device skins' inline SVG glyphs (`icons.ts`): generic shapes, no vendor marks. */
export function Glyph({ svg }: { svg: string }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, static SVG from icons.ts
  return <i className="mbn-i" dangerouslySetInnerHTML={{ __html: svg }} />
}

/** The `data-*` attributes every element showing one notification carries. */
export const useAttrs = () => {
  const store = useStore()
  return (n: Notification) => notificationAttrs(n, store.isUnread(n.id))
}
