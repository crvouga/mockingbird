/**
 * A GitHub emulator in the browser with a user and, unless told otherwise, the app registered as
 * an OAuth app; and the OAuth dance the settings stories go through to be signed in.
 */
import { createRuntime } from "@crvouga/mockingbird-service-github"
import type { Emulator } from "../../../src/frame.js"
import { CALLBACK, signedIn } from "../oauth/browser.js"

/** The origin the emulator believes it is served from. */
export const ORIGIN = "https://github.mock"
export const CLIENT_ID = "Iv1.storybook"
const SECRET = "storybook-secret"

export function github({ registered = true } = {}) {
  const emulator = createRuntime({
    fixtures: {
      users: [{ login: "octocat", name: "The Octocat", email: "octocat@example.test" }],
      ...(registered
        ? {
            oauth_apps: [
              {
                client_id: CLIENT_ID,
                client_secret: SECRET,
                name: "Acme CI",
                redirect_uris: [CALLBACK],
              },
            ],
          }
        : {}),
    },
  })
  const form = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    emulator.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams(body),
      }),
    )
  return {
    emulator,
    /**
     * `octocat` authorizes the app (`scope`) and the app exchanges the code: the grant the
     * settings pages list. Returns the emulator as a browser signed in as `octocat` sees it.
     */
    async authorize(scope = "read:user user:email repo"): Promise<Emulator> {
      const callback = await form("/login/oauth/callback", {
        login: "octocat",
        redirect_uri: CALLBACK,
        scope,
        state: "story-state",
        client_id: CLIENT_ID,
      })
      const code = new URL(callback.headers.get("location") ?? "").searchParams.get("code") ?? ""
      const token = (await (
        await form(
          "/login/oauth/access_token",
          { client_id: CLIENT_ID, client_secret: SECRET, code },
          { accept: "application/json" },
        )
      ).json()) as { access_token: string }
      return signedIn(emulator, { authorization: `Bearer ${token.access_token}` })
    },
  }
}
