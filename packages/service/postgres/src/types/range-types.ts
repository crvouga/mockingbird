/** The built-in range types, by name: a dependency-free leaf so `value.ts` can build its tables from it. */
export const RANGE_SUBTYPES: Readonly<Record<string, string>> = {
  int4range: "int4",
  int8range: "int8",
  numrange: "numeric",
  daterange: "date",
  tsrange: "timestamp",
  tstzrange: "timestamptz",
};

/** pg_type oids of the range types and of their array types. */
export const RANGE_TYPE_OIDS: Readonly<Record<string, number>> = {
  int4range: 3904,
  numrange: 3906,
  tsrange: 3908,
  tstzrange: 3910,
  daterange: 3912,
  int8range: 3926,
};
export const RANGE_ARRAY_OIDS: Readonly<Record<string, number>> = {
  int4range: 3905,
  numrange: 3907,
  tsrange: 3909,
  tstzrange: 3911,
  daterange: 3913,
  int8range: 3927,
};

export function isRangeType(t: string): boolean {
  return RANGE_SUBTYPES[t] !== undefined;
}

/** The built-in multirange types and the range type each is made of. */
export const MULTIRANGE_RANGES: Readonly<Record<string, string>> = {
  int4multirange: "int4range",
  int8multirange: "int8range",
  nummultirange: "numrange",
  datemultirange: "daterange",
  tsmultirange: "tsrange",
  tstzmultirange: "tstzrange",
};

/** pg_type oids of the multirange types and of their array types. */
export const MULTIRANGE_TYPE_OIDS: Readonly<Record<string, number>> = {
  int4multirange: 4451,
  nummultirange: 4532,
  tsmultirange: 4533,
  tstzmultirange: 4534,
  datemultirange: 4535,
  int8multirange: 4536,
};
export const MULTIRANGE_ARRAY_OIDS: Readonly<Record<string, number>> = {
  int4multirange: 6150,
  nummultirange: 6151,
  tsmultirange: 6152,
  tstzmultirange: 6153,
  datemultirange: 6155,
  int8multirange: 6157,
};
