import { parity, queryErrorParity } from "../helpers.ts";

queryErrorParity("int4 addition overflow", [], "SELECT 2147483647 + 1", "numeric_out_of_range");
queryErrorParity("int4 subtraction overflow", [], "SELECT -2147483647 - 2", "numeric_out_of_range");
queryErrorParity("int4 multiplication overflow", [], "SELECT 100000 * 100000", "numeric_out_of_range");
queryErrorParity("int2 addition overflow", [], "SELECT 32767::int2 + 1::int2", "numeric_out_of_range");
queryErrorParity("int8 addition overflow", [], "SELECT 9223372036854775807 + 1", "numeric_out_of_range");
queryErrorParity("int2 cast overflow", [], "SELECT 70000::int2", "numeric_out_of_range");
queryErrorParity("int4 cast overflow", [], "SELECT 3000000000::int4", "numeric_out_of_range");
queryErrorParity("int8 cast overflow from numeric", [], "SELECT 99999999999999999999::int8", "numeric_out_of_range");
queryErrorParity("abs int4 min overflow", [], "SELECT abs((-2147483648)::int4)", "numeric_out_of_range");
queryErrorParity("int4 min division overflow", [], "SELECT (-2147483648)::int4 / (-1)", "numeric_out_of_range");
parity("int4 boundary values ok", [], "SELECT 2147483647::int4 AS hi, (-2147483648)::int4 AS lo");
parity("int2 boundary values ok", [], "SELECT 32767::int2 AS hi, (-32768)::int2 AS lo");
parity("int8 boundary ok", [], "SELECT 9223372036854775807::int8 AS hi");
parity("int2 plus int4 widens without overflow", [], "SELECT 32767::int2 + 1 AS v");
