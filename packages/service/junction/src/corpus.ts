import data from "./corpus-data.js"
import { parseSealedCorpus, type SealedCorpus } from "./sealed-corpus.js"

/**
 * The corpus shipped with this package, recorded from the Junction sandbox: area and
 * PSC serviceability for a fixed ZIP set, plus the recording team's lab catalog.
 *
 * Its catalog is the recording team's, not yours — lab-test ids differ per team. To
 * serve your own catalog and lab accounts, record your team with
 * `mockingbird-junction corpus pull` and load that file instead.
 *
 * A separate entry point, so importing the mock does not parse megabytes of JSON.
 */
export const defaultCorpus: SealedCorpus = parseSealedCorpus(data)
