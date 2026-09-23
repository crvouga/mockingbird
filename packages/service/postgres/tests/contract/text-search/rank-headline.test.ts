import { parity, rankParity } from "../helpers.ts";

rankParity(
  "ts_rank for a simple match",
  [],
  "SELECT ts_rank(to_tsvector('english', 'quick brown fox'), to_tsquery('english', 'fox')) AS v",
);

rankParity(
  "ts_rank is higher for more matched terms",
  [],
  "SELECT ts_rank(to_tsvector('english', 'a b c d'), to_tsquery('english', 'b & d')) AS two, ts_rank(to_tsvector('english', 'a b c d'), to_tsquery('english', 'b')) AS one",
);

rankParity(
  "ts_rank with a normalization flag",
  [],
  "SELECT ts_rank(to_tsvector('english', 'a b c d'), to_tsquery('english', 'b & d'), 2) AS v",
);

rankParity(
  "ts_rank with an explicit weights array",
  [],
  "SELECT ts_rank(array[0.1, 0.2, 0.4, 1.0]::float4[], setweight(to_tsvector('english', 'cat'), 'A'), to_tsquery('english', 'cat')) AS v",
);

rankParity(
  "ts_rank zero when there is no match",
  [],
  "SELECT ts_rank(to_tsvector('english', 'cat'), to_tsquery('english', 'dog')) AS v",
);

rankParity(
  "ts_rank ordering over table rows",
  ["CREATE TABLE docs (id int, body text)", "INSERT INTO docs VALUES (1, 'fox'), (2, 'fox fox fox'), (3, 'fox fox')"],
  "SELECT id, ts_rank(to_tsvector('english', body), to_tsquery('english', 'fox')) AS r FROM docs ORDER BY r DESC, id",
);

parity(
  "ts_headline wraps matches in default markers",
  [],
  "SELECT ts_headline('english', 'The quick brown fox', to_tsquery('english', 'fox')) AS v",
);

parity(
  "ts_headline with custom start and stop markers",
  [],
  "SELECT ts_headline('english', 'The quick brown fox jumps', to_tsquery('english', 'fox'), 'StartSel=<<, StopSel=>>') AS v",
);

parity(
  "ts_headline highlights multiple matches",
  [],
  "SELECT ts_headline('english', 'fox chases fox', to_tsquery('english', 'fox')) AS v",
);

parity(
  "ts_headline with a stemmed query term",
  [],
  "SELECT ts_headline('english', 'many foxes ran', to_tsquery('english', 'fox')) AS v",
);
