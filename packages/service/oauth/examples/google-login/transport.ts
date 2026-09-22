export const COOKIE_HEADERS = { request: "x-example-cookie", response: "x-example-set-cookie" }
export const ORIGIN_HEADER = "x-example-origin"

/** A tiny, portable browser transport. Cookies and redirects never leave this instance. */
export function createBrowser(fetch: (request: Request) => Promise<Response>) {
  const cookies = new Map<
    string,
    { origin: string; path: string; name: string; value: string; expires: number }
  >()
  return {
    async navigate(
      input: string,
      init: { method?: string; body?: URLSearchParams; origin?: string } = {},
    ) {
      let url = new URL(input)
      let method = init.method ?? "GET"
      let body = init.body
      for (let redirects = 0; redirects < 15; redirects++) {
        const headers = new Headers()
        const matching = [...cookies.values()].filter(
          (c) =>
            c.origin === url.origin &&
            (url.pathname === c.path ||
              url.pathname.startsWith(c.path.endsWith("/") ? c.path : `${c.path}/`)) &&
            c.expires > Date.now(),
        )
        if (matching.length)
          headers.set(
            COOKIE_HEADERS.request,
            matching.map((c) => `${c.name}=${c.value}`).join("; "),
          )
        if (method !== "GET" && init.origin) headers.set(ORIGIN_HEADER, init.origin)
        const response = await fetch(
          new Request(url, { method, headers, ...(method !== "GET" && body ? { body } : {}) }),
        )
        for (const line of response.headers
          .get(COOKIE_HEADERS.response)
          ?.split(/,(?=\s*[^;,]+=)/) ?? []) {
          const [pair = "", ...attributes] = line.split(";")
          const split = pair.indexOf("=")
          const name = pair.slice(0, split).trim()
          const value = pair.slice(split + 1)
          const attrs = new Map(
            attributes.map((s) => {
              const [key = "", ...v] = s.trim().split("=")
              return [key.toLowerCase(), v.join("=")]
            }),
          )
          const path = attrs.get("path") ?? "/"
          const expires = attrs.has("max-age")
            ? Date.now() + Number(attrs.get("max-age")) * 1000
            : attrs.has("expires")
              ? Date.parse(attrs.get("expires") ?? "")
              : Infinity
          cookies.set(`${url.origin}:${path}:${name}`, {
            origin: url.origin,
            path,
            name,
            value,
            expires,
          })
        }
        const location = response.headers.get("location")
        if (!location || ![301, 302, 303, 307, 308].includes(response.status))
          return { url: url.href, response }
        url = new URL(location, url)
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === "POST")
        ) {
          method = "GET"
          body = undefined
        }
      }
      throw new Error("Too many redirects")
    },
  }
}
