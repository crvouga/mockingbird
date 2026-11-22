/** Pure helpers behind app routes: the path prefix each app owns, and which app a path opens. */

/**
 * A route as the registry keeps it: a path starting with "/", without a trailing slash (except
 * "/" itself), query or fragment. Throws on anything else.
 */
export function normalizeRoute(route: string): string {
  if (typeof route !== "string" || !route.startsWith("/") || /[?#\s]/.test(route))
    throw new Error(`Invalid route ${JSON.stringify(route)}: use a path such as "/" or "/partner"`)
  let end = route.length
  while (end > 1 && route.charCodeAt(end - 1) === 47) end--
  const normalized = route.slice(0, end)
  if (normalized.includes("//")) throw new Error(`Invalid route ${JSON.stringify(route)}`)
  return normalized
}

/** Whether `pathname` is inside `route` ("/partner" owns "/partner" and "/partner/…", not "/partners"). */
export function routeOwns(route: string, pathname: string): boolean {
  return route === "/" || pathname === route || pathname.startsWith(`${route}/`)
}

/** The id whose route owns `pathname`, the longest route winning; undefined when none does. */
export function matchRoute(
  routes: readonly { id: string; route?: string | undefined }[],
  pathname: string,
): string | undefined {
  let best: { id: string; length: number } | undefined
  for (const { id, route } of routes) {
    if (route === undefined || !routeOwns(route, pathname)) continue
    if (!best || route.length > best.length) best = { id, length: route.length }
  }
  return best?.id
}

/** Pairs of ids that declare the same route: neither could ever be reached by a deep link. */
export function routeConflicts(
  routes: readonly { id: string; route?: string | undefined }[],
): { route: string; ids: [string, string] }[] {
  const owners = new Map<string, string>()
  const conflicts: { route: string; ids: [string, string] }[] = []
  for (const { id, route } of routes) {
    if (route === undefined) continue
    const owner = owners.get(route)
    if (owner === undefined) owners.set(route, id)
    else conflicts.push({ route, ids: [owner, id] })
  }
  return conflicts
}
