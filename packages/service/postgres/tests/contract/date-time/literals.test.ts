import { parity, parityTyped } from "../helpers.ts";

parity("date literal", [], "SELECT date '2024-01-15' AS v");
parity("date cast from text", [], "SELECT '2024-01-15'::date AS v");
parity("date compact numeric input format", [], "SELECT '20240115'::date AS v");
parity("timestamp literal", [], "SELECT timestamp '2024-01-15 10:30:00' AS v");
parity("timestamp with fractional seconds", [], "SELECT timestamp '2024-01-15 10:30:00.123456' AS v");
parity("timestamp without seconds", [], "SELECT '2024-01-15 10:30'::timestamp AS v");
parity("timestamp iso t separator", [], "SELECT '2024-01-15T10:30:00'::timestamp AS v");
parity("time literal", [], "SELECT time '10:30:00' AS v, time '23:59:59.999' AS w");
parity("epoch special value", [], "SELECT 'epoch'::timestamp AS v");
parity("infinity dates", [], "SELECT 'infinity'::date::text AS a, '-infinity'::date::text AS b");
parity("infinity timestamps", [], "SELECT 'infinity'::timestamp::text AS a, '-infinity'::timestamp::text AS b");
parity("infinity comparisons", [], "SELECT 'infinity'::date > '2024-01-01'::date AS a");
parityTyped("date literal type", [], "SELECT date '2024-01-15' AS v");
parityTyped("timestamp literal type", [], "SELECT timestamp '2024-01-15 10:30:00' AS v");
parity("leap day valid", [], "SELECT '2024-02-29'::date AS v");
parity("date output of century boundaries", [], "SELECT '1999-12-31'::date AS a, '2000-01-01'::date AS b");
parity("timestamp seconds rounding on output", [], "SELECT '2024-01-15 10:30:00.000000'::timestamp AS v");
