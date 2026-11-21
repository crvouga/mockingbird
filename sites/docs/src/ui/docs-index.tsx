import { PageHeader } from "@crvouga/mockingbird-ui/react"
import { Link } from "@heroui/react"
import type { ReactNode } from "react"
import { GuideCard, type GuideLink } from "./guide.tsx"
import { Section, TextLink } from "./primitives.tsx"
import { ServiceGrid, type ServiceSummary } from "./service-card.tsx"

export function DocsIndexHeader() {
  return (
    <PageHeader
      eyebrow="Developer documentation"
      title="Docs"
      description={
        <>
          Guides for using, testing and contributing to Mockingbird. Each page is a file in{" "}
          <code className="font-mono">docs/</code>, the same markdown GitHub renders, so the two
          never differ. Each service's own guide is its README, on its{" "}
          <Link href="/services" className="text-sm">
            service page
          </Link>
          .
        </>
      }
    />
  )
}

/** The featured emulators at the top of the docs index. */
export function FeaturedSection({ services }: { services: ServiceSummary[] }) {
  return (
    <Section
      id="featured"
      title="Featured emulators"
      description={`Explore the guides, coverage, and live playgrounds for these ${services.length} emulators.`}
      actions={
        <TextLink href="/services?featured=1" arrow>
          Browse featured emulators
        </TextLink>
      }
    >
      <ServiceGrid services={services} />
    </Section>
  )
}

/** A guide that is a set of pages: its summary, then a card per page (or `children`). */
export function GuideSection({
  guide,
  pages,
  children,
}: {
  guide: GuideLink
  pages: GuideLink[]
  children?: ReactNode
}) {
  return (
    <Section
      id={`section-${guide.slug}`}
      title={
        <a href={`/docs/${guide.slug}`} className="text-foreground no-underline hover:text-accent">
          {guide.title}
        </a>
      }
      description={guide.summary}
    >
      {children ?? <GuideGrid guides={pages} />}
    </Section>
  )
}

export function GuideGrid({ guides, icon = false }: { guides: GuideLink[]; icon?: boolean }) {
  return (
    <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-4 p-0">
      {guides.map((guide) => (
        <li key={guide.slug}>
          <GuideCard guide={guide} icon={icon} />
        </li>
      ))}
    </ul>
  )
}

/** Every top-level guide. */
export function AllGuides({ guides }: { guides: GuideLink[] }) {
  return (
    <Section id="guides" title="Guides">
      <GuideGrid guides={guides} icon />
    </Section>
  )
}
