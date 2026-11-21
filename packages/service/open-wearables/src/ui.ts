import type { Provider } from "./state.js"

/*
 * The browser pages live in ./ui/server.tsx (React + HeroUI), prebuilt into dist-ui/server.js.
 * They are imported here only when a page is requested, so the API never loads React.
 */
const pages = () => import("#ui/server")

export const pairingPage = async (
  providers: readonly Provider[],
  userId: string,
  redirectUrl = "",
  prefix = "",
): Promise<string> => (await pages()).pairingPage(providers, userId, redirectUrl, prefix)

export const consentPage = async (provider: string, action: string): Promise<string> =>
  (await pages()).consentPage(provider, action)

export const completionPage = async (allowed: boolean): Promise<string> =>
  (await pages()).completionPage(allowed)

export const html = (body: string) =>
  new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'",
    },
  })
