import { queryErrorParity } from "../helpers.ts";

queryErrorParity("text abc to int", [], "SELECT 'abc'::int", "invalid_text_representation");
queryErrorParity("decimal text to int", [], "SELECT '1.5'::int", "invalid_text_representation");
queryErrorParity("text to float8 invalid", [], "SELECT 'abc'::float8", "invalid_text_representation");
queryErrorParity("text to numeric invalid", [], "SELECT 'abc'::numeric", "invalid_text_representation");
queryErrorParity("incomplete exponent to numeric", [], "SELECT '1e'::numeric", "invalid_text_representation");
queryErrorParity("text to bool invalid", [], "SELECT '10'::bool", "invalid_text_representation");
queryErrorParity("text maybe to bool invalid", [], "SELECT 'maybe'::bool", "invalid_text_representation");
queryErrorParity("empty string to bool", [], "SELECT ''::bool", "invalid_text_representation");
queryErrorParity("numeric typmod overflow", [], "SELECT 1000::numeric(3, 1)", "numeric_out_of_range");
queryErrorParity("numeric typmod overflow after rounding", [], "SELECT 99.99::numeric(3, 1)", "numeric_out_of_range");
queryErrorParity("text with inner space to int", [], "SELECT '1 2'::int", "invalid_text_representation");
queryErrorParity("float text with garbage", [], "SELECT '1.5x'::float8", "invalid_text_representation");
