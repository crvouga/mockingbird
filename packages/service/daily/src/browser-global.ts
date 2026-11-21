import { type BrowserOptions, createDailyIframe } from "./browser.js"

export function install(options: BrowserOptions) {
  const scope = globalThis as unknown as { DailyIframe?: ReturnType<typeof createDailyIframe> }
  if (scope.DailyIframe?.getCallInstance()) throw new Error("A Daily call object is already active")
  scope.DailyIframe = createDailyIframe(options)
}
