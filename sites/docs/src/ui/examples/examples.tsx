import { PageHeader } from "@crvouga/mockingbird-ui/react"
import { Card, Chip, Link } from "@heroui/react"
import type { AppExample } from "../../lib/appExamples.ts"
import { CodeFrame } from "../code.tsx"
import { ButtonLink, LinkChip, Section } from "../primitives.tsx"

export type ServiceRef = { name: string; displayName: string } | null

/** The services an example composes, each linking to its emulator when it has one. */
export function ServiceChips({
  names,
  services,
}: {
  names: string[]
  services: Record<string, ServiceRef>
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {names.map((name) => {
        const service = services[name]
        return service ? (
          <LinkChip key={name} href={`/services/${service.name}`}>
            {service.displayName}
          </LinkChip>
        ) : (
          <Chip key={name} variant="soft" size="sm">
            <Chip.Label>{name}</Chip.Label>
          </Chip>
        )
      })}
    </div>
  )
}

/** /examples: every full-stack example app, as cards. */
export function ExamplesIndex({
  examples,
  services,
  repo,
}: {
  examples: readonly AppExample[]
  services: Record<string, ServiceRef>
  repo: string
}) {
  return (
    <>
      <PageHeader
        title="Examples"
        description="Small, real full-stack apps that compose Mockingbird's emulators the way you would in production — client, server, database, and every “vendor” call in one process, with no real network. Each one is a working app you can run locally, not a snippet."
      />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,21rem),1fr))] gap-4">
        {examples.map((example) => (
          <Card key={example.slug} className="h-full">
            <Card.Header>
              <h2 className="text-lg font-semibold">
                <Link href={`/examples/${example.slug}`} className="text-foreground">
                  {example.title}
                </Link>
              </h2>
            </Card.Header>
            <Card.Content className="flex flex-col gap-3">
              <p className="text-sm leading-relaxed text-muted">{example.description}</p>
              <ServiceChips names={example.servicesUsed} services={services} />
            </Card.Content>
            <Card.Footer className="mt-auto flex flex-wrap gap-2">
              <ButtonLink
                href={`/examples/${example.slug}`}
                variant="primary"
                size="sm"
                icon="play"
              >
                Live demo
              </ButtonLink>
              <ButtonLink
                href={`${repo}/tree/main/${example.packagePath}`}
                size="sm"
                icon="github"
                external
              >
                Source
              </ButtonLink>
            </Card.Footer>
          </Card>
        ))}
      </div>
    </>
  )
}

const CAPABILITIES = [
  {
    title: "Patient workspace",
    body: "Search the catalog, build an order, pay, track progress, explore biomarker reports, and download records.",
  },
  {
    title: "Clinical review",
    body: "Inspect all patient reports, compare values and reference ranges, and add a signed, timestamped review.",
  },
  {
    title: "Administration",
    body: "Manage patient, clinician, and administrator roles with server-enforced permissions and an audit log.",
  },
]

/** The lab ordering example's page, above and below its launcher (passed from the page). */
export function MedicalTestingIntro({
  example,
  services,
}: {
  example: AppExample
  services: Record<string, ServiceRef>
}) {
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <PageHeader
        eyebrow={<Link href="/examples">Examples</Link>}
        title={example.title}
        description={example.description}
      />
      <div className="-mt-2">
        <ServiceChips names={example.servicesUsed} services={services} />
      </div>
      <p className="mt-6 text-sm leading-relaxed text-muted">
        Everything in the app runs in this browser tab: sign-in by emailed code or Google/Apple
        OAuth, the shop, the Stripe checkout, the Junction fulfillment, the Postgres-backed order
        history, and every message it sends through Resend (email), Twilio (SMS, WhatsApp and Verify
        codes), FCM (push to an iPhone and an Android phone) and Slack (staff alerts). The
        fullscreen view is one dashboard with three tabs: <strong>Example</strong> is the app,{" "}
        <strong>Emulators</strong> is one live admin UI for every emulator it talks to, and{" "}
        <strong>Notifications</strong> shows every message on a phone, a mailbox and a chat window.
        No server to start, and no real network call to any provider.
      </p>
    </div>
  )
}

export function MedicalTestingCapabilities() {
  return (
    <div className="my-6 grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-4">
      {CAPABILITIES.map((capability) => (
        <Card key={capability.title}>
          <Card.Header>
            <h2 className="text-base font-semibold text-foreground">{capability.title}</h2>
          </Card.Header>
          <Card.Content>
            <p className="text-sm leading-relaxed text-muted">{capability.body}</p>
          </Card.Content>
        </Card>
      ))}
    </div>
  )
}

/** How to drive the example, above its launcher. */
export function MedicalTestingHowTo() {
  return (
    <p className="mb-4 max-w-3xl text-sm leading-relaxed text-muted">
      Pick Ada (patient), Morgan (clinician), or Alex (administrator) on the sign-in screen and ask
      for a code: the app says where it sent it, and “Open Notifications” takes you to that email.
      Then pay for a test and watch the receipt, shipping and result updates arrive. Account has the
      phone verification, the per-channel switches and a “send a test” button for each channel. Ada
      starts with two fictional reports. Changes last until the example closes; reopening starts a
      fresh workspace.
    </p>
  )
}

/** The same app as a standalone package with a real dev server. */
export function RunLocally({ runHtml, source }: { runHtml: string; source: string }) {
  return (
    <div className="mt-12 max-w-3xl">
      <Section
        title="Run it locally instead"
        description="This is the exact same code as a standalone app you can clone and run with a real dev server, if you'd rather poke at it outside the browser:"
      >
        <div className="flex flex-col items-start gap-4">
          <CodeFrame html={runHtml} label="Shell" icon="terminal" className="w-full" />
          <ButtonLink href={source} size="sm" icon="github" external>
            Source
          </ButtonLink>
        </div>
      </Section>
    </div>
  )
}
