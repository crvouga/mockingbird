export const initials = (name: string): string =>
  name
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase()

export const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const

export const installCommand = (pm: (typeof PACKAGE_MANAGERS)[number], pkg: string): string =>
  ({
    npm: `npm install -D ${pkg}`,
    pnpm: `pnpm add -D ${pkg}`,
    yarn: `yarn add -D ${pkg}`,
    bun: `bun add -d ${pkg}`,
  })[pm]

export const percent = (part: number, whole: number): number =>
  whole === 0 ? 100 : Math.round((part / whole) * 100)
