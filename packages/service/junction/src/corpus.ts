import data from "./corpus-data.js"
import { parseSealedCorpus, type SealedCorpus } from "./sealed-corpus.js"

/** Synthetic sealed example. Load a private corpus to reproduce a specific team. */
export const defaultCorpus: SealedCorpus = parseSealedCorpus(data)
