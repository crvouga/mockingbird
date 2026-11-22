/**
 * The provider emulators' pages as HTML. Prebuilt into `dist-ui/server.js` by
 * packages/ui/scripts/bundle.ts and imported lazily (`#ui/server`, see `vendor/core/ui.ts`), so
 * React never loads on an API request.
 */
import type { DocumentScript } from "@crvouga/mockingbird-ui/document"
import { renderPage } from "@crvouga/mockingbird-ui/react/server"
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import type { ProviderPage } from "./model.js"
import { ProviderPageView } from "./page.js"

/** Submits the page's first form as soon as it loads (`response_mode=form_post`). */
const AUTO_SUBMIT: DocumentScript = {
  source: "var MockingbirdFormPost={submit:function(){document.forms[0].submit()}}",
  call: "MockingbirdFormPost.submit",
}

/** `page` as a complete document: static HTML whose forms post natively. */
export function renderProviderPage(page: ProviderPage): string {
  const script = page.layout === "card" && page.autoSubmit ? AUTO_SUBMIT : undefined
  return renderPage(<ProviderPageView page={page} />, {
    title: page.layout === "app" ? (page.heading ?? page.title) : page.title,
    css: MOCKINGBIRD_CSS,
    rememberTheme: true,
    ...(script ? { script } : {}),
  })
}
