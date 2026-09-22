import { parity } from "../helpers.ts";

parity(
  "tsvector || concatenation shifts positions",
  [],
  "SELECT (to_tsvector('english', 'black cat') || to_tsvector('english', 'white dog')) AS v",
);

parity(
  "tsvector || with an empty vector",
  [],
  "SELECT (to_tsvector('english', 'cat') || to_tsvector('english', '')) AS v",
);

parity("tsquery && combines with AND", [], "SELECT ('a'::tsquery && 'b'::tsquery)::text AS v");

parity("tsquery || combines with OR", [], "SELECT ('a'::tsquery || 'b'::tsquery)::text AS v");

parity("!! negates a tsquery", [], "SELECT (!! 'a'::tsquery)::text AS v");

parity(
  "combined tsquery operators match correctly",
  [],
  "SELECT to_tsvector('english', 'cat dog') @@ ('cat'::tsquery && 'dog'::tsquery) AS both, to_tsvector('english', 'cat') @@ ('cat'::tsquery && 'dog'::tsquery) AS missing",
);

parity("negated tsquery via !! in a match", [], "SELECT to_tsvector('english', 'cat') @@ (!! 'dog'::tsquery) AS v");

parity(
  "phrase operator <-> inside to_tsquery",
  [],
  "SELECT to_tsvector('english', 'quick brown fox') @@ to_tsquery('english', 'quick <-> brown') AS adjacent, to_tsvector('english', 'quick red brown') @@ to_tsquery('english', 'quick <-> brown') AS gap",
);

parity(
  "phrase distance <2> matches exactly two apart",
  [],
  "SELECT to_tsvector('english', 'one two three') @@ to_tsquery('english', 'one <2> three') AS v",
);

parity(
  "phraseto_tsquery matching behaves like adjacent phrase",
  [],
  "SELECT to_tsvector('english', 'quick brown fox') @@ phraseto_tsquery('english', 'brown fox') AS v",
);

parity("setweight assigns weight A", [], "SELECT setweight(to_tsvector('english', 'cat dog'), 'A') AS v");

parity("setweight assigns weight D", [], "SELECT setweight(to_tsvector('english', 'cat dog'), 'D') AS v");

parity(
  "setweight combined with concatenation",
  [],
  "SELECT (setweight(to_tsvector('english', 'title words'), 'A') || setweight(to_tsvector('english', 'body words'), 'B')) AS v",
);

parity(
  "strip removes positions and weights",
  [],
  "SELECT strip(setweight(to_tsvector('english', 'cat dog cat'), 'A')) AS v",
);

parity("length counts distinct lexemes", [], "SELECT length(to_tsvector('english', 'cat dog cat bird')) AS v");

parity("length of an empty tsvector", [], "SELECT length(to_tsvector('english', '')) AS v");

parity("numnode counts tsquery nodes", [], "SELECT numnode(to_tsquery('english', 'cat & dog')) AS v");
