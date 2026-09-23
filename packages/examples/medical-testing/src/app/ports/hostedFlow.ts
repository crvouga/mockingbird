/**
 * Shared shape for any provider integration that hands control to a real,
 * hosted, form-driven web page before coming back to us — an OAuth sign-in
 * screen, a payments hosted checkout page, anything with that "redirect
 * away, do something, redirect back" contract. The caller renders `html`
 * verbatim, intercepts the page's own form submits/link clicks, and posts
 * each one back through `step`/`continue*` until it resolves.
 */
export type HostedFlowStep<T> =
  | { kind: "html"; flowId: string; html: string }
  | { kind: "done"; result: T }
  | { kind: "error"; message: string }
