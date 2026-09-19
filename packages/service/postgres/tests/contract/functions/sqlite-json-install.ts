/**
 * Individual DDL statements that install SQLite JSON1-shaped functions on
 * Postgres. Ordered so helpers exist before dependents. Each statement is
 * run via exec (function bodies contain `;`).
 *
 * Common call shapes match SQLite (`json_extract(col, '$.a')`). Postgres
 * type-name collisions (`json`) and VARIADIC quirks are avoided.
 */

export const SQLITE_JSON_INSTALL_STATEMENTS: readonly string[] = [
  `
CREATE OR REPLACE FUNCTION sqlite_json_atom_text(v jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
BEGIN
  IF v IS NULL THEN
    RETURN NULL;
  END IF;
  CASE jsonb_typeof(v)
    WHEN 'null' THEN RETURN NULL;
    WHEN 'string' THEN RETURN trim(both '"' from v::text);
    WHEN 'number' THEN RETURN v::text;
    WHEN 'boolean' THEN RETURN v::text;
    ELSE RETURN v::text;
  END CASE;
END;
$fn$
`.trim(),
  `
CREATE OR REPLACE FUNCTION json_valid(p_text text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
BEGIN
  IF p_text IS NULL THEN
    RETURN false;
  END IF;
  PERFORM p_text::jsonb;
  RETURN true;
EXCEPTION
  WHEN others THEN
    RETURN false;
END;
$fn$
`.trim(),
  `
CREATE OR REPLACE FUNCTION json_type(p_text text, p_path text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v jsonb;
  v_path text;
BEGIN
  IF p_text IS NULL THEN
    RETURN NULL;
  END IF;
  v := p_text::jsonb;
  v_path := COALESCE(NULLIF(p_path, ''), '$');
  IF v_path <> '$' THEN
    v := jsonb_path_query_first(v, v_path::jsonpath);
  END IF;
  IF v IS NULL THEN
    RETURN NULL;
  END IF;
  CASE jsonb_typeof(v)
    WHEN 'object' THEN RETURN 'object';
    WHEN 'array' THEN RETURN 'array';
    WHEN 'string' THEN RETURN 'text';
    WHEN 'number' THEN RETURN 'real';
    WHEN 'boolean' THEN RETURN 'true';
    WHEN 'null' THEN RETURN 'null';
    ELSE RETURN jsonb_typeof(v);
  END CASE;
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$fn$
`.trim(),
  `
CREATE OR REPLACE FUNCTION json_type(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT json_type(p_text, '$');
$fn$
`.trim(),
  `
CREATE OR REPLACE FUNCTION json_array_length(p_text text, p_path text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v jsonb;
BEGIN
  IF p_text IS NULL THEN
    RETURN NULL;
  END IF;
  v := p_text::jsonb;
  IF p_path IS NOT NULL AND p_path <> '$' THEN
    v := jsonb_path_query_first(v, p_path::jsonpath);
  END IF;
  IF v IS NULL OR jsonb_typeof(v) <> 'array' THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_array_length(v);
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$fn$
`.trim(),
  `
CREATE OR REPLACE FUNCTION json_array_length(p_text text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT json_array_length(p_text, NULL::text);
$fn$
`.trim(),
  `
CREATE OR REPLACE FUNCTION json_extract(p_text text, p_path text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v jsonb;
  extracted jsonb;
BEGIN
  IF p_text IS NULL OR p_path IS NULL THEN
    RETURN NULL;
  END IF;
  v := p_text::jsonb;
  IF p_path = '$' THEN
    RETURN sqlite_json_atom_text(v);
  END IF;
  extracted := jsonb_path_query_first(v, p_path::jsonpath);
  RETURN sqlite_json_atom_text(extracted);
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$fn$
`.trim(),
  `
CREATE OR REPLACE FUNCTION json_quote(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT to_jsonb(p_value)::text;
$fn$
`.trim(),
  `
CREATE OR REPLACE FUNCTION sqlite_json_path_to_text_array(p_path text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  cleaned text;
  jp text[];
BEGIN
  cleaned := regexp_replace(
    regexp_replace(COALESCE(p_path, ''), '^\\$', ''),
    '\\[([0-9]+)\\]',
    ',\\1',
    'g'
  );
  jp := string_to_array(cleaned, '.');
  RETURN array_remove(jp, '');
END;
$fn$
`.trim(),
  `
CREATE OR REPLACE FUNCTION json_set(p_text text, p_path text, p_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v jsonb;
  jp text[];
BEGIN
  IF p_text IS NULL THEN RETURN NULL; END IF;
  v := p_text::jsonb;
  jp := sqlite_json_path_to_text_array(p_path);
  IF cardinality(jp) = 0 THEN RETURN v::text; END IF;
  BEGIN
    v := jsonb_set(v, jp, p_value::jsonb, true);
  EXCEPTION
    WHEN others THEN
      v := jsonb_set(v, jp, to_jsonb(p_value), true);
  END;
  RETURN v::text;
EXCEPTION
  WHEN others THEN
    RETURN p_text;
END;
$fn$
`.trim(),
  `
CREATE OR REPLACE FUNCTION json_insert(p_text text, p_path text, p_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v jsonb;
  jp text[];
  existing jsonb;
BEGIN
  IF p_text IS NULL THEN RETURN NULL; END IF;
  v := p_text::jsonb;
  jp := sqlite_json_path_to_text_array(p_path);
  IF cardinality(jp) = 0 THEN RETURN v::text; END IF;
  existing := v #> jp;
  IF existing IS NOT NULL THEN RETURN v::text; END IF;
  BEGIN
    v := jsonb_set(v, jp, p_value::jsonb, true);
  EXCEPTION
    WHEN others THEN
      v := jsonb_set(v, jp, to_jsonb(p_value), true);
  END;
  RETURN v::text;
EXCEPTION
  WHEN others THEN
    RETURN p_text;
END;
$fn$
`.trim(),
  `
CREATE OR REPLACE FUNCTION json_replace(p_text text, p_path text, p_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v jsonb;
  jp text[];
  existing jsonb;
BEGIN
  IF p_text IS NULL THEN RETURN NULL; END IF;
  v := p_text::jsonb;
  jp := sqlite_json_path_to_text_array(p_path);
  IF cardinality(jp) = 0 THEN RETURN v::text; END IF;
  existing := v #> jp;
  IF existing IS NULL THEN RETURN v::text; END IF;
  BEGIN
    v := jsonb_set(v, jp, p_value::jsonb, false);
  EXCEPTION
    WHEN others THEN
      v := jsonb_set(v, jp, to_jsonb(p_value), false);
  END;
  RETURN v::text;
EXCEPTION
  WHEN others THEN
    RETURN p_text;
END;
$fn$
`.trim(),
  `
CREATE OR REPLACE FUNCTION json_remove(p_text text, p_path text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v jsonb;
  jp text[];
BEGIN
  IF p_text IS NULL THEN RETURN NULL; END IF;
  v := p_text::jsonb;
  jp := sqlite_json_path_to_text_array(p_path);
  IF cardinality(jp) > 0 THEN
    v := v #- jp;
  END IF;
  RETURN v::text;
EXCEPTION
  WHEN others THEN
    RETURN p_text;
END;
$fn$
`.trim(),
  `
CREATE OR REPLACE FUNCTION json_patch(p_target text, p_patch text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN p_target IS NULL OR p_patch IS NULL THEN NULL
    ELSE (p_target::jsonb || p_patch::jsonb)::text
  END;
$fn$
`.trim(),
  `
CREATE OR REPLACE FUNCTION json_each(p_text text, p_path text)
RETURNS TABLE (
  key text,
  value text,
  type text,
  atom text,
  id bigint,
  parent bigint,
  fullkey text,
  path text
)
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v jsonb;
  v_path text;
  el jsonb;
  obj_key text;
  idx int := 0;
  row_id bigint := 1;
BEGIN
  IF p_text IS NULL THEN
    RETURN;
  END IF;
  v := p_text::jsonb;
  v_path := COALESCE(NULLIF(p_path, ''), '$');
  IF v_path <> '$' THEN
    v := jsonb_path_query_first(v, v_path::jsonpath);
  END IF;
  IF v IS NULL THEN
    RETURN;
  END IF;
  IF jsonb_typeof(v) = 'array' THEN
    FOR el IN SELECT * FROM jsonb_array_elements(v) LOOP
      key := idx::text;
      value := el::text;
      type := CASE jsonb_typeof(el)
        WHEN 'object' THEN 'object'
        WHEN 'array' THEN 'array'
        WHEN 'string' THEN 'text'
        WHEN 'number' THEN 'real'
        WHEN 'boolean' THEN 'true'
        WHEN 'null' THEN 'null'
        ELSE jsonb_typeof(el)
      END;
      atom := sqlite_json_atom_text(el);
      id := row_id;
      parent := 0;
      fullkey := v_path || '[' || idx::text || ']';
      path := v_path;
      RETURN NEXT;
      idx := idx + 1;
      row_id := row_id + 1;
    END LOOP;
  ELSIF jsonb_typeof(v) = 'object' THEN
    FOR obj_key, el IN SELECT * FROM jsonb_each(v) LOOP
      key := obj_key;
      value := el::text;
      type := CASE jsonb_typeof(el)
        WHEN 'object' THEN 'object'
        WHEN 'array' THEN 'array'
        WHEN 'string' THEN 'text'
        WHEN 'number' THEN 'real'
        WHEN 'boolean' THEN 'true'
        WHEN 'null' THEN 'null'
        ELSE jsonb_typeof(el)
      END;
      atom := sqlite_json_atom_text(el);
      id := row_id;
      parent := 0;
      fullkey := v_path || '.' || obj_key;
      path := v_path;
      RETURN NEXT;
      row_id := row_id + 1;
    END LOOP;
  END IF;
END;
$fn$
`.trim(),
  `
CREATE OR REPLACE FUNCTION json_each(p_text text)
RETURNS TABLE (
  key text,
  value text,
  type text,
  atom text,
  id bigint,
  parent bigint,
  fullkey text,
  path text
)
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT * FROM json_each(p_text, '$');
$fn$
`.trim(),
];
