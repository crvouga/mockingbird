import {
  ArrowRight,
  ArrowRotateLeft,
  ArrowUpRightFromSquare,
  Bars,
  Bell,
  Box,
  Check,
  ChevronRight,
  Comment,
  Copy,
  Database,
  Display,
  Envelope,
  FaceRobot,
  FileText,
  Globe,
  Key,
  Layers,
  LayoutCells,
  ListUl,
  LogoGithub,
  Magnifier,
  Moon,
  Play,
  PlugConnection,
  Pulse,
  ShieldCheck,
  Star,
  StarFill,
  Sun,
  Terminal,
  Thunderbolt,
  Xmark,
} from "@gravity-ui/icons"
import type { ComponentType, SVGProps } from "react"

/**
 * The docs site's icons by the names its copy uses (`lib/content.ts` names a feature's icon
 * "plug", "layers", …), drawn from @gravity-ui/icons, the set HeroUI and every other Mockingbird
 * surface use.
 */
const ICONS = {
  "arrow-right": ArrowRight,
  activity: Pulse,
  bell: Bell,
  bot: FaceRobot,
  check: Check,
  chevron: ChevronRight,
  copy: Copy,
  database: Database,
  external: ArrowUpRightFromSquare,
  file: FileText,
  github: LogoGithub,
  globe: Globe,
  grid: LayoutCells,
  key: Key,
  layers: Layers,
  list: ListUl,
  mail: Envelope,
  menu: Bars,
  message: Comment,
  moon: Moon,
  package: Box,
  play: Play,
  plug: PlugConnection,
  reset: ArrowRotateLeft,
  search: Magnifier,
  shield: ShieldCheck,
  star: Star,
  "star-fill": StarFill,
  sun: Sun,
  system: Display,
  terminal: Terminal,
  x: Xmark,
  zap: Thunderbolt,
} satisfies Record<string, ComponentType<SVGProps<SVGSVGElement>>>

export type IconName = keyof typeof ICONS

export const isIconName = (name: string): name is IconName => name in ICONS

export type IconProps = {
  name: IconName | (string & {})
  className?: string
  /** Announced name; without one the icon is decorative. */
  label?: string
}

/** One icon by name, 16px by default; size it with `size-*`, color it with `text-*`. */
export function Icon({ name, className = "size-4", label }: IconProps) {
  const Svg = isIconName(name) ? ICONS[name] : FileText
  return label ? (
    <Svg className={className} role="img" aria-label={label} />
  ) : (
    <Svg className={className} aria-hidden="true" />
  )
}
