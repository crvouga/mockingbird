-- jsonb: extraction, containment, existence, concatenation, jsonb_set, path access.
CREATE TABLE docs (id int PRIMARY KEY, doc jsonb NOT NULL);
INSERT INTO docs VALUES (1, '{"a": 1, "tags": ["x", "y"], "meta": {"depth": 2}}');
INSERT INTO docs VALUES (2, '{"a": 2, "tags": [], "flag": true}');
INSERT INTO docs VALUES (3, '{"b": null, "tags": ["y", "z", "w"]}');
SELECT id, doc ->> 'a' AS a, doc -> 'tags' ->> 0 AS t0 FROM docs ORDER BY id;
SELECT id FROM docs WHERE doc @> '{"a": 1}' ORDER BY id;
SELECT id FROM docs WHERE doc ? 'flag' ORDER BY id;
SELECT id, jsonb_array_length(doc -> 'tags') AS ntags FROM docs ORDER BY id;
SELECT id, doc #> '{meta,depth}' AS depth, doc #>> '{tags,1}' AS tag1 FROM docs ORDER BY id;
SELECT id, doc || '{"z": true}' AS merged FROM docs ORDER BY id;
SELECT id, jsonb_set(doc, '{a}', '99') AS bumped FROM docs WHERE doc ? 'a' ORDER BY id;
SELECT id, doc - 'tags' AS trimmed FROM docs ORDER BY id;
SELECT id, jsonb_typeof(doc -> 'b') AS btype FROM docs WHERE doc ? 'b' ORDER BY id;
