/**
 * An organization's `mockingbird.yaml`: the file that declares its projects, fleets and emulators,
 * how to apply it, and the screen that releases the organization from it.
 */
import { CodeBlock } from "@crvouga/mockingbird-ui/react"
import type { ReactNode } from "react"
import { mutation } from "../form.js"
import {
  A,
  type Child,
  Code,
  DownloadButton,
  FILE,
  File,
  Properties,
  Section,
  Sub,
} from "../kit.js"
import type { Context } from "../router.js"
import { titleOf, to } from "../routes.js"
import { api, land, moment, ui } from "../runtime.js"
import type { DeclarationView } from "../types.js"
import { orgCrumbs, orgFor, type TabContext } from "./org.js"

/** Text to read or copy whole: a file or commands, under a line that says what it is. */
const Block = ({
  label,
  text,
  what,
  download,
}: {
  label: string
  text: string
  what: string
  download?: boolean
}) => (
  <CodeBlock
    code={text}
    label={label}
    copyLabel={`Copy ${what}`}
    {...(download ? { actions: <DownloadButton text={text} name={label} /> } : {})}
  />
)

const Step = ({
  index,
  title,
  children,
}: {
  index: number
  title: string
  children: ReactNode
}) => (
  <li className="flex gap-4">
    <span
      aria-hidden="true"
      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-default text-sm font-semibold text-muted"
    >
      {index}
    </span>
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <h3 className="text-base font-semibold">{title}</h3>
      {children}
    </div>
  </li>
)

const Text = ({ children }: { children: ReactNode }) => <p className="text-sm">{children}</p>

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
    body: (
      <>
        <div className="mb-4">
          <Sub>
            {managed ? (
              <>
                This organization is configured by <File />. Its projects, fleets and emulators are
                read-only in the dashboard and the API, and change when the file is applied.
              </>
            ) : (
              <>
                This organization is configured by hand. Below is its configuration as a <File />,
                generated from its projects, fleets and emulators as they are now. Applying this
                file changes nothing and puts the organization under the file's control.
              </>
            )}
          </Sub>
        </div>
        <Properties
          label="Configuration status"
          rows={[
            {
              name: "Controlled by",
              value: managed ? <File /> : "Configured by hand",
              about: `configuration:${org.id}`,
              change: managed && admin && (
                <A
                  href={to("org.configuration.release", { org: org.id })}
                  aria-label={`Release the organization from ${FILE}`}
                >
                  Release
                </A>
              ),
            },
            managed && {
              name: "Last applied",
              value: `${moment(managed.appliedAt)} by ${managed.appliedBy}`,
            },
          ]}
        />
        <Section title="The file">
          <Block label={FILE} text={view.yaml} what={FILE} download />
          {empty ? (
            <>
              <Sub>
                The file declares no projects yet. Add them under <Code>projects</Code>, for
                example:
              </Sub>
              <Block label="Example" text={example(org.slug, origin)} what="the example" />
            </>
          ) : null}
          <Sub>
            Members, invites and API keys are not declared in the file: they are people and secrets.
          </Sub>
        </Section>
        <Section title="Apply it from your repository">
          <ol className="m-0 flex list-none flex-col gap-8 p-0">
            <Step index={1} title="Commit the file">
              <Text>
                Save it as <File /> in your repository and change it there.
              </Text>
            </Step>
            <Step index={2} title="Plan, then apply">
              <Text>
                <Code>plan</Code> shows what would change and changes nothing. <Code>apply</Code>{" "}
                makes the organization match the file. The token is a{" "}
                <A href={to("account")}>personal token</A> of an admin, or an admin{" "}
                {admin ? <A href={to("org.keys", { org: org.id })}>API key</A> : "API key"}.
              </Text>
              <Block label="Shell" text={cli} what="the plan and apply commands" />
              <Text>
                What the file no longer declares is deleted, with its stored state, only when you
                add <Code>--prune</Code>.
              </Text>
            </Step>
            <Step index={3} title="Or call the API">
              <Text>
                No CLI is needed: the API takes the file as it is. Add <Code>?dryRun=true</Code> to
                plan.
              </Text>
              <Block label="Shell" text={curl} what="the curl command" />
            </Step>
            <Step index={4} title="Run the same fleet locally">
              <Text>The same file starts these emulators on your machine.</Text>
              <Block label="Shell" text={serve} what="the serve command" />
            </Step>
          </ol>
        </Section>
      </>
    ),
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
    crumbs: orgCrumbs(org, { href: back, label: "Configuration" }, "Release"),
    lead: (
      <>
        Nothing is deleted: every project, fleet and emulator stays as it is, with its stored state.
        The dashboard and the API can change them by hand again. The next apply of a <File /> for
        this organization takes control back.
      </>
    ),
    facts: (
      <Properties
        label="Configuration status"
        rows={[
          {
            name: "Last applied",
            value: `${moment(org.managed.appliedAt)} by ${org.managed.appliedBy}`,
          },
        ]}
      />
    ),
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
