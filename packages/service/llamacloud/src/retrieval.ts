import type { DocumentRecord, RetrievalRule, ScriptedNode } from "./state.js"

/**
 * Deterministic retrieval. The real service embeds, runs hybrid search and reranks; the mock
 * ranks whole documents by how many of the query's terms they contain, so the same query over
 * the same documents always answers the same nodes in the same order.
 */

const STOPWORDS = new Set(
  (
    "a an and are as at be but by can do does for from has have how i if in is it its me my no " +
    "not of on or our should so than that the their them then there these they this to was we " +
    "what when where which who why will with you your"
  ).split(" "),
)

/** Lower-cased alphanumeric terms of two or more characters, minus stopwords. */
export const terms = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (term) => term.length > 1 && !STOPWORDS.has(term),
  )

export type RankedDocument = { document: DocumentRecord; score: number }

/**
 * Score = share of distinct query terms found in the document's text or title, rounded to 4
 * places. Documents that match nothing are dropped; ties keep insertion order.
 */
export const rank = (
  query: string,
  documents: readonly DocumentRecord[],
  topK: number,
): RankedDocument[] => {
  const wanted = [...new Set(terms(query))]
  if (wanted.length === 0) return []
  return documents
    .map((document, index) => {
      const title = typeof document.metadata.title === "string" ? document.metadata.title : ""
      const have = new Set(terms(`${title} ${document.text}`))
      const hits = wanted.filter((term) => have.has(term)).length
      return { document, index, score: Math.round((hits / wanted.length) * 10_000) / 10_000 }
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, topK)
    .map(({ document, score }) => ({ document, score }))
}

/** The first rule (most recently added first) whose `contains` and `pipeline` match. */
export const matchRule = (
  rules: readonly RetrievalRule[],
  query: string,
  pipeline: { id: string; name: string },
): RetrievalRule | undefined =>
  rules.find((rule) => {
    const contains = rule.match.contains
    if (contains !== undefined && !query.toLowerCase().includes(contains.toLowerCase())) {
      return false
    }
    const target = rule.match.pipeline
    return target === undefined || target === pipeline.id || target === pipeline.name
  })

/**
 * A `TextNode`. The official client's model (llama-cloud 0.1.45 `TextNode`) names the metadata
 * field `extra_info`; our backend adapter reads `node.metadata`. Which one the live API sends
 * is unverified (no sandbox credentials), so the mock sends both, with the same content.
 */
const textNode = (id: string, text: string, metadata: Record<string, unknown>) => ({
  id_: id,
  text,
  metadata,
  extra_info: metadata,
  class_name: "TextNode",
  mimetype: "text/plain",
  start_char_idx: 0,
  end_char_idx: text.length,
  excluded_embed_metadata_keys: [],
  excluded_llm_metadata_keys: [],
  relationships: {},
  text_template: "{metadata_str}\n\n{content}",
  metadata_template: "{key}: {value}",
  metadata_seperator: "\n",
})

/** A ranked document as a `TextNodeWithScore`, carrying `document_id` like LlamaCloud does. */
export const documentNode = (pipelineId: string, ranked: RankedDocument) => ({
  node: textNode(`${ranked.document.id}_0`, ranked.document.text, {
    ...ranked.document.metadata,
    document_id: ranked.document.id,
    pipeline_id: pipelineId,
  }),
  score: ranked.score,
  class_name: "NodeWithScore",
})

/** A scripted node as a `TextNodeWithScore`; the score defaults to a descending 1, 0.9, … */
export const scriptedNode = (node: ScriptedNode, index: number) => ({
  node: textNode(`scripted_${index}`, node.text, { ...(node.metadata ?? {}) }),
  score: node.score ?? Math.max(0, Math.round((1 - index * 0.1) * 100) / 100),
  class_name: "NodeWithScore",
})
