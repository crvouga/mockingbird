import { queryErrorParity } from "../helpers.ts";

queryErrorParity("unterminated object fails with 22P02", [], `SELECT '{bad'::jsonb`, "invalid_text_representation");

queryErrorParity("bare word fails with 22P02", [], `SELECT 'nope'::jsonb`, "invalid_text_representation");

queryErrorParity(
  "trailing garbage after valid json fails with 22P02",
  [],
  `SELECT '{"a":1}x'::jsonb`,
  "invalid_text_representation",
);

queryErrorParity("single quotes are not valid json", [], `SELECT '{''a'':1}'::jsonb`, "invalid_text_representation");

queryErrorParity("unclosed array fails with 22P02", [], `SELECT '[1,2'::jsonb`, "invalid_text_representation");

queryErrorParity("empty string is not valid json", [], `SELECT ''::jsonb`, "invalid_text_representation");

queryErrorParity(
  "jsonb_array_length on an object fails with 22023",
  [],
  `SELECT jsonb_array_length('{}'::jsonb)`,
  "invalid_parameter",
);

queryErrorParity(
  "invalid json in a json cast also fails with 22P02",
  [],
  `SELECT '{bad'::json`,
  "invalid_text_representation",
);

queryErrorParity(
  "malformed jsonb inserted into a jsonb column fails",
  ["CREATE TABLE docs (body jsonb)"],
  `INSERT INTO docs VALUES ('{oops')`,
  "invalid_text_representation",
);
