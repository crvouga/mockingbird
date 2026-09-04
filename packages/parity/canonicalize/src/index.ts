export type {
  CanonicalBody,
  CanonicalExchange,
  CanonicalizeOptions,
  DiscoveredIdentity,
  Exchange,
} from "./canonical.js"
export {
  canonicalizeExchange,
  canonicalizeValue,
  discoverIdentities,
  replaceKnownIds,
  unknownToken,
  volatileToken,
} from "./canonical.js"
export type { Difference } from "./diff.js"
export { formatDifference, formatPath, structuralDiff } from "./diff.js"
