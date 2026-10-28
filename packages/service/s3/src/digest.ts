import { awsMd5 } from "@crvouga/mockingbird-service"

/** Lowercase hex MD5, an S3 ETag without its quotes. */
export const md5Hex = (bytes: Uint8Array): string => awsMd5(bytes)

/** Base64 MD5, the `Content-MD5` header form. */
export const md5Base64 = (bytes: Uint8Array): string => {
  const hex = awsMd5(bytes)
  let binary = ""
  for (let index = 0; index < hex.length; index += 2)
    binary += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16))
  return btoa(binary)
}

/** The multipart ETag: MD5 of the concatenated binary part MD5s, then `-<count>`. */
export const multipartEtag = (partEtags: readonly string[]): string => {
  const bytes = new Uint8Array(partEtags.length * 16)
  partEtags.forEach((etag, index) => {
    const clean = etag.replace(/"/g, "")
    for (let offset = 0; offset < 16; offset++)
      bytes[index * 16 + offset] = Number.parseInt(clean.slice(offset * 2, offset * 2 + 2), 16)
  })
  return `${awsMd5(bytes)}-${partEtags.length}`
}
