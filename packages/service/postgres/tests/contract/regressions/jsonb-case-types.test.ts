import { parity, parityTyped, sequenceParity } from "../helpers.ts";

// #443: synthetic reduction of the reported migration's acquisition/coverage views.
// Empty relations probe CASE with NULL inputs; this must retain the JSONB branch type.
const setup = [
  "CREATE SCHEMA finance",
  "CREATE TABLE inputs (id int, payload jsonb)",
  `CREATE FUNCTION finance.touch_value(touch jsonb, k text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN touch IS NULL OR jsonb_typeof(touch -> k) <> 'string' THEN NULL
      ELSE NULLIF(btrim(touch ->> k), '') END
  $$`,
  `CREATE VIEW acquisition AS
    WITH eligible AS (SELECT id FROM inputs)
    SELECT u.id, finance.touch_value(touch.touch, 'key') AS value
    FROM inputs u JOIN eligible e ON e.id = u.id
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN jsonb_typeof(u.payload -> 'first_touch') = 'object' THEN u.payload -> 'first_touch'
        WHEN jsonb_typeof(u.payload) = 'object' THEN u.payload
        ELSE NULL END AS touch,
        CASE WHEN jsonb_typeof(u.payload) = 'object' THEN 'object' ELSE NULL END AS source
    ) touch`,
  "CREATE VIEW coverage AS SELECT value, COUNT(*) AS n FROM acquisition GROUP BY value",
];

parity("#443 empty nested views preserve a lateral JSONB CASE argument", setup, "SELECT * FROM coverage");

parity(
  "#443 JSONB CASE function calls work with objects and NULL inputs",
  [
    ...setup,
    `INSERT INTO inputs VALUES (1, '{"key":" top "}'),
      (2, '{"first_touch":{"key":" nested "}}'), (3, NULL), (4, '[]')`,
  ],
  "SELECT * FROM acquisition ORDER BY id",
);

parityTyped(
  "#443 JSONB CASE retains its type when every row selects an untyped NULL",
  [...setup, "INSERT INTO inputs VALUES (1, NULL), (2, '[]')"],
  `SELECT CASE WHEN jsonb_typeof(payload) = 'object' THEN payload ELSE NULL END AS value FROM inputs ORDER BY id`,
);

parityTyped(
  "#443 simple and nested CASE infer JSONB through operators, casts and implicit NULL",
  [...setup, "INSERT INTO inputs VALUES (1, NULL)"],
  `SELECT CASE id WHEN 2 THEN payload -> 'key' END AS extracted,
    CASE WHEN false THEN NULL WHEN false THEN CASE WHEN true THEN payload END END AS nested,
    CASE WHEN false THEN NULL::jsonb END AS casted,
    CASE WHEN false THEN payload ELSE '{}' END AS literal
    FROM inputs`,
);

sequenceParity(
  "#443 CASE type discovery does not run unselected expressions",
  ["CREATE SEQUENCE counter"],
  [
    {
      query: true,
      sql: `SELECT CASE WHEN false THEN nextval('counter')::text::jsonb
        WHEN false THEN (1 / 0)::text::jsonb END AS value`,
    },
    { query: true, sql: "SELECT nextval('counter') AS first_value" },
  ],
);
