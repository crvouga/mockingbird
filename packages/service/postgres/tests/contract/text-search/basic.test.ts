import { parity } from "../helpers.ts";

parity(
  "to_tsvector with english config stems and positions",
  [],
  "SELECT to_tsvector('english', 'The quick brown foxes jumped') AS v",
);

parity("to_tsvector default config", [], "SELECT to_tsvector('The quick brown fox') AS v");

parity("to_tsvector simple config keeps stop words", [], "SELECT to_tsvector('simple', 'The Quick Brown') AS v");

parity(
  "to_tsvector repeated lexemes keep all positions",
  [],
  "SELECT to_tsvector('english', 'cat dog cat bird cat') AS v",
);

parity("to_tsvector of an empty string", [], "SELECT to_tsvector('english', '') AS v");

parity("to_tsquery with AND", [], "SELECT to_tsquery('english', 'quick & brown') AS v");

parity("to_tsquery with OR and NOT", [], "SELECT to_tsquery('english', 'quick | !brown') AS v");

parity("to_tsquery stems terms", [], "SELECT to_tsquery('english', 'jumping') AS v");

parity("plainto_tsquery ANDs plain words", [], "SELECT plainto_tsquery('english', 'quick brown foxes') AS v");

parity("plainto_tsquery ignores punctuation", [], "SELECT plainto_tsquery('english', 'quick, brown & foxes!') AS v");

parity("phraseto_tsquery builds a phrase query", [], "SELECT phraseto_tsquery('english', 'quick brown fox') AS v");

parity("tsvector literal cast", [], "SELECT 'cat dog'::tsvector AS v");

parity("tsvector literal with positions", [], "SELECT 'cat:1 dog:2'::tsvector AS v");

parity("tsquery literal cast", [], "SELECT 'cat & dog'::tsquery AS v");

parity(
  "@@ matches a stemmed word",
  [],
  "SELECT to_tsvector('english', 'quick brown foxes') @@ to_tsquery('english', 'fox') AS v",
);

parity(
  "@@ no match returns false",
  [],
  "SELECT to_tsvector('english', 'quick brown fox') @@ to_tsquery('english', 'cat') AS v",
);

parity(
  "@@ with AND requires both terms",
  [],
  "SELECT to_tsvector('english', 'quick brown') @@ to_tsquery('english', 'quick & brown') AS both, to_tsvector('english', 'quick') @@ to_tsquery('english', 'quick & brown') AS missing",
);

parity(
  "@@ with OR requires either term",
  [],
  "SELECT to_tsvector('english', 'quick') @@ to_tsquery('english', 'quick | brown') AS v",
);

parity(
  "@@ with NOT excludes matches",
  [],
  "SELECT to_tsvector('english', 'cat') @@ to_tsquery('english', '!dog') AS yes, to_tsvector('english', 'cat dog') @@ to_tsquery('english', 'cat & !dog') AS no",
);

parity(
  "@@ over table rows",
  [
    "CREATE TABLE docs (id int, body text)",
    "INSERT INTO docs VALUES (1, 'the quick brown fox'), (2, 'lazy dogs sleep'), (3, 'foxes and dogs')",
  ],
  "SELECT id FROM docs WHERE to_tsvector('english', body) @@ to_tsquery('english', 'fox') ORDER BY id",
);
