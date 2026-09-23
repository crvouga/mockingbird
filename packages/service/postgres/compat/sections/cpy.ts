import { type CatalogSection, section } from "../scenario-types.ts";

const D = "documented_divergence" as const;
const CPY_NOTE =
  "COPY data flows through the JS copyFrom API / result rows; the PGlite adapter streams COPY separately, so no differential compare is possible";
const EXTRA = ["tests/contract/copy/"];
const DIV = "copy-stdin-api";

export const CPY_SECTION: CatalogSection = section("CPY", "COPY", true, [
  ["from-01", "COPY FROM STDIN text loads rows and returns the count", D, CPY_NOTE, EXTRA, DIV],
  ["from-02", "\\N is NULL and text escapes decode", D, CPY_NOTE, EXTRA, DIV],
  ["from-03", "\\. terminates the stream", D, CPY_NOTE, EXTRA, DIV],
  ["from-04", "column list may reorder and omit columns", D, CPY_NOTE, EXTRA, DIV],
  ["from-05", "values pass through type input and constraints", D, CPY_NOTE, EXTRA, DIV],
  ["csv-01", "csv quoted fields, delimiters, doubled quotes", D, CPY_NOTE, EXTRA, DIV],
  ["csv-02", "csv empty unquoted is NULL; quoted empty is not", D, CPY_NOTE, EXTRA, DIV],
  ["csv-03", "csv HEADER, DELIMITER, and NULL options", D, CPY_NOTE, EXTRA, DIV],
  ["to-01", "COPY TO STDOUT text renders \\N nulls and escapes", D, CPY_NOTE, EXTRA, DIV],
  ["to-02", "COPY TO STDOUT csv quotes only when needed", D, CPY_NOTE, EXTRA, DIV],
  ["to-03", "COPY (SELECT ...) TO STDOUT supports queries", D, CPY_NOTE, EXTRA, DIV],
  ["to-04", "COPY TO STDOUT respects the column list", D, CPY_NOTE, EXTRA, DIV],
  ["rt-01", "COPY TO output round-trips through COPY FROM", D, CPY_NOTE, EXTRA, DIV],
  ["api-01", "copyFrom rejects non-COPY statements as misuse", D, CPY_NOTE, EXTRA, DIV],
]);
