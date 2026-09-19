import { parity, parityTyped } from "../helpers.ts";

parity("coalesce basic", [], "SELECT coalesce(NULL, 'a') AS a, coalesce('x', 'y') AS b, coalesce(NULL, NULL, 3) AS c");
parity("coalesce all null", [], "SELECT coalesce(NULL::int, NULL::int) AS v");
parity("coalesce short circuits", [], "SELECT coalesce(1, 1 / 0) AS v");
parity("nullif equal yields null", [], "SELECT nullif(1, 1) AS a, nullif('x', 'x') AS b");
parity("nullif different yields first", [], "SELECT nullif(1, 2) AS a, nullif('x', 'y') AS b");
parity("nullif with null argument", [], "SELECT nullif(NULL::int, 1) AS a, nullif(1, NULL::int) AS b");
parity("greatest basic", [], "SELECT greatest(1, 5, 3) AS a, greatest(-1, -5) AS b");
parity("least basic", [], "SELECT least(1, 5, 3) AS a, least(-1, -5) AS b");
parity("greatest ignores nulls", [], "SELECT greatest(1, NULL, 3) AS v");
parity("least ignores nulls", [], "SELECT least(NULL, 5, NULL, 2) AS v");
parity("greatest all null", [], "SELECT greatest(NULL::int, NULL::int) AS v");
parity("greatest least text", [], "SELECT greatest('apple', 'banana') AS a, least('apple', 'banana') AS b");
parity("greatest mixed numeric types", [], "SELECT greatest(1, 2.5, 2) AS v");
parityTyped("greatest type resolution", [], "SELECT greatest(1, 2.5) AS v");
parity("nested conditionals", [], "SELECT coalesce(nullif('a', 'a'), 'fallback') AS v");
