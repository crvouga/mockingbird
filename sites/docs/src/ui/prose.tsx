/**
 * Rendered markdown (a README, a guide, a code sample's source), styled from the theme's tokens
 * like the rest of the site. The HTML comes from integrations/catalog/markdown.ts at build time;
 * its code fences already carry the shared code frame.
 */
const PROSE = [
  "min-w-0 text-[15px] leading-7 text-foreground",
  "[&>*+*]:mt-4",
  // Headings: h2 opens a section with a rule, as GitHub draws them.
  "[&_h2]:mt-14 [&_h2]:border-t [&_h2]:border-separator [&_h2]:pt-4 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight",
  "[&_h3]:mt-10 [&_h3]:text-lg [&_h3]:font-semibold",
  "[&_h4]:mt-8 [&_h4]:text-base [&_h4]:font-semibold",
  "[&_h2]:scroll-mt-20 [&_h3]:scroll-mt-20 [&_h4]:scroll-mt-20",
  "[&_.anchor]:-ml-5 [&_.anchor]:mr-1 [&_.anchor]:inline-block [&_.anchor]:w-4 [&_.anchor]:text-muted [&_.anchor]:no-underline [&_.anchor]:opacity-0",
  "[&_h2:hover_.anchor]:opacity-100 [&_h3:hover_.anchor]:opacity-100 [&_h4:hover_.anchor]:opacity-100",
  // Text
  "[&_a:not(.anchor):not([data-copy])]:text-link [&_a:not(.anchor)]:underline [&_a:not(.anchor)]:decoration-separator [&_a:not(.anchor)]:underline-offset-4 [&_a:not(.anchor):hover]:decoration-current",
  "[&_strong]:font-semibold",
  "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-default [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.85em] [&_:not(pre)>code]:[overflow-wrap:anywhere]",
  // Lists
  "[&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li+li]:mt-1.5 [&_li::marker]:text-muted",
  // Quotes and rules
  "[&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted",
  "[&_hr]:my-10 [&_hr]:border-separator",
  "[&_img]:max-w-full [&_img]:rounded-md",
  // Tables, as HeroUI's Table draws them
  "[&_.table-wrap]:overflow-x-auto [&_.table-wrap]:rounded-lg [&_.table-wrap]:border [&_.table-wrap]:border-border [&_.table-wrap]:bg-surface",
  "[&_table]:w-full [&_table]:border-collapse [&_table]:text-sm",
  "[&_th]:bg-surface-secondary [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted",
  "[&_td]:border-t [&_td]:border-separator [&_td]:px-3 [&_td]:py-2 [&_td]:align-top",
  // Code fences without a frame (a raw Shiki block)
  "[&>pre]:overflow-x-auto [&>pre]:rounded-lg [&>pre]:border [&>pre]:border-border [&>pre]:bg-surface-secondary! [&>pre]:p-3 [&>pre]:font-mono [&>pre]:text-[13px]",
].join(" ")

export function Prose({
  html,
  className,
  as: Tag = "div",
}: {
  html: string
  className?: string
  as?: "div" | "article"
}) {
  return (
    <Tag
      className={`${PROSE} ${className ?? ""}`.trim()}
      data-prose
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
