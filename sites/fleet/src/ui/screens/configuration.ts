/**
 * An organization's `mockingbird.yaml`: the file that declares its projects, fleets and emulators,
 * how to apply it, and the screen that releases the organization from it.
 */
import { type Child, h } from "../dom.js"
import { mutation } from "../form.js"
import type { Context } from "../router.js"
import { titleOf, to } from "../routes.js"
import { api, land, link, moment, properties, section, ui } from "../runtime.js"
import type { DeclarationView } from "../types.js"
import { orgCrumbs, orgFor, type TabContext } from "./org.js"

const FILE = "mockingbird.yaml"
const file = () => h("code", {}, FILE)

/** A button that copies `text`. Copying changes nothing on the server. */
function copy(text: string, what: string) {
  const button = h(
    "button.small",
    { type: "button", "data-local": "copy", "aria-label": `Copy ${what}` },
    "Copy",
  )
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(text).catch(() => {})
    button.textContent = "Copied"
    setTimeout(() => (button.textContent = "Copy"), 1500)
  })
  return button
}

/** A button that saves `text` as a file on this machine. */
function download(text: string, name: string) {
  const button = h(
    "button.small",
    { type: "button", "data-local": "download", "aria-label": `Download ${name}` },
    "Download",
  )
  button.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([text], { type: "application/yaml" }))
    h("a", { href: url, download: name }).click()
    URL.revokeObjectURL(url)
  })
  return button
}

/** Text to read or copy whole: a file or commands, under a line that says what it is. */
const block = (label: Child, text: string, ...actions: Child[]) =>
  h(
    ".code",
    {},
    h(".code-head", {}, h("span.code-label", {}, label), h(".code-actions", {}, actions)),
    h("pre", { tabindex: "0" }, h("code", {}, text)),
  )

const step = (title: string, ...content: Child[]) => h("li", {}, h("h3", {}, title), content)

/** What a file that declares nothing yet could declare. */
const example = (slug: string, origin: string) => `projects:
  web:
    name: Web app
    fleets:
      ${slug}-staging:        # served at ${origin}/f/${slug}-staging
        access: open          # or: key
        services:
          stripe: { durability: strict }
          resend: {}          # every default: buffered
`

export async function configuration({ org, admin }: TabContext): Promise<{ body: Child }> {
  const view = await api<DeclarationView>("GET", `/orgs/${org.id}/manifest`)
  const { managed } = view
  const origin = ui.address.origin()
  const empty = Object.keys(view.declaration.projects ?? {}).length === 0
  const cli = `export MOCKINGBIRD_FLEET_URL=${origin}
export MOCKINGBIRD_FLEET_TOKEN=mbf_…

npx mockingbird-fleet plan
npx mockingbird-fleet apply
`
  const curl = `curl -X PUT "$MOCKINGBIRD_FLEET_URL/api/v1/manifest" \\
  -H "Authorization: Bearer $MOCKINGBIRD_FLEET_TOKEN" \\
  -H "content-type: application/yaml" \\
  --data-binary @${FILE}
`
  const serve = `npx mockingbird-fleet serve --config ${FILE}\n`
  return {
    body: [
      h(
        "p.sub.intro",
        {},
        managed
          ? [
              "This organization is configured by ",
              file(),
              ". Its projects, fleets and emulators are read-only in the dashboard and the API, and change when the file is applied.",
            ]
          : [
              "This organization is configured by hand. Below is its configuration as a ",
              file(),
              ", generated from its projects, fleets and emulators as they are now. Applying this file changes nothing and puts the organization under the file's control.",
            ],
      ),
      properties("Configuration status", [
        {
          name: "Controlled by",
          value: managed ? file() : "Configured by hand",
          about: `configuration:${org.id}`,
          change:
            managed &&
            admin &&
            link(
              to("org.configuration.release", { org: org.id }),
              { "aria-label": `Release the organization from ${FILE}` },
              "Release",
            ),
        },
        managed
          ? { name: "Last applied", value: `${moment(managed.appliedAt)} by ${managed.appliedBy}` }
          : false,
      ]),
      section(
        "The file",
        null,
        block(FILE, view.yaml, copy(view.yaml, FILE), download(view.yaml, FILE)),
        empty && [
          h(
            "p.sub.after",
            {},
            "The file declares no projects yet. Add them under ",
            h("code", {}, "projects"),
            ", for example:",
          ),
          block(
            "Example",
            example(org.slug, origin),
            copy(example(org.slug, origin), "the example"),
          ),
        ],
        h(
          "p.sub.after",
          {},
          "Members, invites and API keys are not declared in the file: they are people and secrets.",
        ),
      ),
      section(
        "Apply it from your repository",
        null,
        h(
          "ol.steps",
          {},
          step(
            "Commit the file",
            h("p", {}, "Save it as ", file(), " in your repository and change it there."),
          ),
          step(
            "Plan, then apply",
            h(
              "p",
              {},
              h("code", {}, "plan"),
              " shows what would change and changes nothing. ",
              h("code", {}, "apply"),
              " makes the organization match the file. The token is a ",
              link(to("account"), {}, "personal token"),
              " of an admin, or an admin ",
              admin ? link(to("org.keys", { org: org.id }), {}, "API key") : "API key",
              ".",
            ),
            block("Shell", cli, copy(cli, "the plan and apply commands")),
            h(
              "p",
              {},
              "What the file no longer declares is deleted, with its stored state, only when you add ",
              h("code.nowrap", {}, "--prune"),
              ".",
            ),
          ),
          step(
            "Or call the API",
            h(
              "p",
              {},
              "No CLI is needed: the API takes the file as it is. Add ",
              h("code.nowrap", {}, "?dryRun=true"),
              " to plan.",
            ),
            block("Shell", curl, copy(curl, "the curl command")),
          ),
          step(
            "Run the same fleet locally",
            h("p", {}, "The same file starts these emulators on your machine."),
            block("Shell", serve, copy(serve, "the serve command")),
          ),
        ),
      ),
    ],
  }
}

export async function configurationRelease({ route, params }: Context) {
  const org = await orgFor(params.org ?? "", "admin", "Releasing the organization")
  const back = to("org.configuration", { org: org.id })
  // Nothing to release: the Configuration tab says the organization is configured by hand.
  if (!org.managed) {
    ui.address.replace(back)
    return undefined
  }
  return mutation({
    title: titleOf(route, { organization: org.name }),
    crumbs: orgCrumbs(org, link(back, {}, "Configuration"), "Release"),
    lead: [
      "Nothing is deleted: every project, fleet and emulator stays as it is, with its stored state. The dashboard and the API can change them by hand again. The next apply of a ",
      file(),
      " for this organization takes control back.",
    ],
    facts: properties("Configuration status", [
      {
        name: "Last applied",
        value: `${moment(org.managed.appliedAt)} by ${org.managed.appliedBy}`,
      },
    ]),
    submit: "Release organization",
    pending: "Releasing…",
    cancel: back,
    failed: "The organization was not released.",
    run: async () => {
      await api("DELETE", `/orgs/${org.id}/manifest`)
      await land(back, { note: { about: `configuration:${org.id}`, text: "Released just now" } })
    },
  })
}
