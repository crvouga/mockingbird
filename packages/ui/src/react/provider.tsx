import { I18nProvider, RouterProvider } from "@heroui/react"
import type { ReactNode } from "react"
import type { DocumentTheme } from "../document.js"

export type MockingbirdTheme = DocumentTheme

export type MockingbirdProviderProps = {
  children?: ReactNode
  /**
   * "system" (the default) follows the visitor's preference. "light" or "dark" pins this subtree.
   * Pin a whole page on `<html>` instead (`renderDocument({ theme })` does), because HeroUI's
   * overlays (menus, modals, tooltips) render into `<body>`, outside this element.
   */
  theme?: MockingbirdTheme
  /** A BCP 47 locale for dates, numbers and text direction. Default: the browser's. */
  locale?: string
  /**
   * Client-side navigation for a single-page app: HeroUI links and menu items with an `href`
   * call this instead of loading a page.
   */
  navigate?: (href: string) => void
  className?: string
}

/**
 * The root of every Mockingbird React surface. HeroUI v3 needs no provider of its own (its theme is
 * CSS), so this only scopes the theme, the base text styles, and React Aria's locale and router.
 * Wrap each React root in exactly one.
 */
export function MockingbirdProvider({
  children,
  theme = "system",
  locale,
  navigate,
  className,
}: MockingbirdProviderProps) {
  let content = (
    <div
      data-mockingbird
      {...(theme === "system" ? {} : { "data-theme": theme })}
      className={`bg-background font-sans text-foreground ${theme === "system" ? "" : theme} ${className ?? ""}`.trim()}
    >
      {children}
    </div>
  )
  if (navigate) content = <RouterProvider navigate={navigate}>{content}</RouterProvider>
  if (locale) content = <I18nProvider locale={locale}>{content}</I18nProvider>
  return content
}
