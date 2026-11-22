import { signInLinkToken } from "./format.js"

/**
 * Following an emailed sign-in link without leaving the page. In a browser tab the whole system
 * lives in the page, so opening the link in a new tab would start another, empty system that never
 * issued it. `composition/browser.ts` hands a click on the link here instead, and the sign-in
 * screen redeems it.
 */
type Follower = (token: string) => void
const followers = new Set<Follower>()

export const onSignInLink = (follower: Follower): (() => void) => {
  followers.add(follower)
  return () => followers.delete(follower)
}

/** Whether `url` is a sign-in link to `page`; if so, the sign-in screen redeems it. */
export const followSignInLink = (url: string, page: string): boolean => {
  const token = signInLinkToken(url)
  const link = URL.parse(url)
  const home = URL.parse(page)
  if (!token || !link || !home) return false
  if (link.origin !== home.origin || link.pathname !== home.pathname) return false
  for (const follower of followers) follower(token)
  return true
}
