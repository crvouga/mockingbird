import { type CatalogSection, section } from "../scenario-types.ts";

export const UNI_SECTION: CatalogSection = section("UNI", "Unicode, encoding, weird text", true, [
  ["utf-01", "multi-byte UTF-8 round-trip"],
  ["len-01", "length/char_length count characters"],
  ["octet-01", "octet_length counts UTF-8 bytes"],
  ["astral-01", "astral-plane length substr position"],
  ["nul-01", "chr(0) is rejected"],
  ["fold-01", "upper/lower on ASCII"],
  ["char-01", "chr/ascii round-trip"],
  ["hex-01", "encode(convert_to(...), 'hex') of multi-byte text"],
  ["esc-01", "E-string unicode escapes"],
]);
