import { queryErrorParity } from "../helpers.ts";

queryErrorParity("numeric division by zero", [], "SELECT 1::numeric / 0", "division_by_zero");
queryErrorParity("numeric division by zero decimal", [], "SELECT 1.5 / 0.0", "division_by_zero");
queryErrorParity("numeric mod by zero", [], "SELECT mod(1::numeric, 0)", "division_by_zero");
queryErrorParity("div by zero", [], "SELECT div(1, 0)", "division_by_zero");
queryErrorParity("numeric typmod overflow", [], "SELECT 12345.6::numeric(5, 2)", "numeric_out_of_range");
queryErrorParity("numeric typmod overflow negative", [], "SELECT -1000::numeric(3)", "numeric_out_of_range");
queryErrorParity("invalid numeric text", [], "SELECT '12.5.6'::numeric", "invalid_text_representation");
queryErrorParity("numeric with spaces inside", [], "SELECT '1 000'::numeric", "invalid_text_representation");
queryErrorParity("infinity to numeric typmod errors", [], "SELECT 'Infinity'::numeric(5, 2)", "numeric_out_of_range");
queryErrorParity("float NaN to int errors", [], "SELECT 'NaN'::float8::int", "numeric_out_of_range");
