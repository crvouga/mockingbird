import {
  ListObjectsCommand,
  type ListObjectsCommandOutput,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3"
import { type Ctx, keyPath, type RequestSpec, type Scenario } from "../harness.js"

type Query = Record<string, string>

const put = (
  s: Ctx,
  bucket: string,
  key: string,
  body = "x",
  headers: Record<string, string> = {},
) => s.raw({ method: "PUT", path: keyPath(bucket, key), body, headers })

const putAll = async (s: Ctx, bucket: string, keys: string[]) => {
  for (const key of keys) {
    const res = await put(s, bucket, key, key)
    if (res.status !== 200) throw new Error(`setup: put ${key} -> ${res.status} ${res.text}`)
  }
}

const del = (s: Ctx, bucket: string, key: string, query: Query = {}) =>
  s.raw({ method: "DELETE", path: keyPath(bucket, key), query })

const versioning = (s: Ctx, bucket: string, status: "Enabled" | "Suspended") =>
  s.raw({
    method: "PUT",
    path: keyPath(bucket),
    query: { versioning: "" },
    body: `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${status}</Status></VersioningConfiguration>`,
  })

const list = (
  s: Ctx,
  step: string,
  bucket: string,
  query: Query | [string, string][] = {},
  extra: Partial<RequestSpec> = {},
) => s.req(step, { method: "GET", path: keyPath(bucket), query, ...extra })

const v2 = (query: Query = {}): Query => ({ "list-type": "2", ...query })
const ver = (query: Query = {}): Query => ({ versions: "", ...query })

/** Follow a listing to its end (at most `pages` requests), recording every page. */
const paginate = async (
  s: Ctx,
  step: string,
  bucket: string,
  kind: "v1" | "v2" | "versions",
  query: Query,
  pages = 8,
) => {
  let next: Query = {}
  for (let page = 1; page <= pages; page++) {
    const base = kind === "v2" ? v2(query) : kind === "versions" ? ver(query) : { ...query }
    const res = await list(s, `${step} page ${page}`, bucket, { ...base, ...next })
    if (res.tag("IsTruncated") !== "true") return
    if (kind === "v2") next = { "continuation-token": res.tag("NextContinuationToken") ?? "" }
    else if (kind === "versions")
      next = {
        "key-marker": res.tag("NextKeyMarker") ?? "",
        "version-id-marker": res.tag("NextVersionIdMarker") ?? "",
      }
    else next = { marker: res.tag("NextMarker") ?? "" }
    if (kind === "versions" && next["version-id-marker"] === "") delete next["version-id-marker"]
  }
}

const TREE = ["a", "b/1", "b/2", "c/d/e", "c/d/f", "c/g", "d", "e/", "e/x", "f-1", "f-2", "f-3"]

export const scenarios: Scenario[] = [
  {
    name: "empty-bucket",
    async run(s) {
      const b = await s.bucket("list-empty")
      await list(s, "v1", b)
      await list(s, "v2", b, v2())
      await list(s, "v2 fetch-owner", b, v2({ "fetch-owner": "true" }))
      await list(s, "v2 metadata", b, v2({ metadata: "true" }))
      await list(s, "versions", b, ver())
      await list(s, "versions metadata", b, ver({ metadata: "true" }))
      await list(s, "v1 all params", b, {
        prefix: "p/",
        delimiter: "/",
        marker: "p/x",
        "max-keys": "5",
        "encoding-type": "url",
      })
      await list(
        s,
        "v2 all params",
        b,
        v2({
          prefix: "p/",
          delimiter: "/",
          "start-after": "p/x",
          "max-keys": "5",
          "encoding-type": "url",
        }),
      )
      await list(
        s,
        "versions all params",
        b,
        ver({
          prefix: "p/",
          delimiter: "/",
          "key-marker": "p/x",
          "max-keys": "5",
          "encoding-type": "url",
        }),
      )
    },
  },
  {
    name: "missing-bucket",
    async run(s) {
      const b = s.name("list-missing")
      await list(s, "v1", b)
      await list(s, "v2", b, v2())
      await list(s, "v2 metadata", b, v2({ metadata: "true" }))
      await list(s, "versions", b, ver())
      await list(s, "versions metadata", b, ver({ metadata: "true" }))
      await list(s, "v1 delimiter", b, { delimiter: "/" })
      // MinIO checks the arguments before it looks for the bucket...
      await list(s, "v1 bad max-keys", b, { "max-keys": "x" })
      await list(s, "v1 negative max-keys", b, { "max-keys": "-1" })
      await list(s, "v2 bad encoding", b, v2({ "encoding-type": "base64" }))
      await list(s, "v2 empty token", b, v2({ "continuation-token": "" }))
      await list(s, "v1 marker outside prefix", b, { prefix: "a", marker: "b" })
      await list(
        s,
        "versions version marker without key marker",
        b,
        ver({ "version-id-marker": "x" }),
      )
      // ...and some listings end before the bucket is ever consulted.
      await list(s, "v1 max-keys 0", b, { "max-keys": "0" })
      await list(s, "v2 max-keys 0", b, v2({ "max-keys": "0" }))
      await list(s, "versions max-keys 0", b, ver({ "max-keys": "0" }))
      await list(s, "v1 max-keys 0 with marker", b, { "max-keys": "0", marker: "a" })
      await list(s, "v1 prefix slash", b, { prefix: "/" })
      await list(s, "v2 prefix slash", b, v2({ prefix: "/x" }))
      await list(s, "versions prefix slash", b, ver({ prefix: "/" }))
      await list(s, "v2 start-after outside prefix", b, v2({ prefix: "a", "start-after": "b" }))
      await list(s, "v1 prefix max-keys 1", b, { prefix: "x", "max-keys": "1" })
    },
  },
  {
    name: "v1-basics",
    async run(s) {
      const b = await s.bucket("list-v1")
      await putAll(s, b, TREE)
      await list(s, "all", b)
      await list(s, "prefix b/", b, { prefix: "b/" })
      await list(s, "prefix b", b, { prefix: "b" })
      await list(s, "prefix c/d", b, { prefix: "c/d" })
      await list(s, "prefix none match", b, { prefix: "zz" })
      await list(s, "delimiter", b, { delimiter: "/" })
      await list(s, "delimiter prefix c/", b, { prefix: "c/", delimiter: "/" })
      await list(s, "delimiter prefix c/d", b, { prefix: "c/d", delimiter: "/" })
      await list(s, "delimiter prefix c/d/", b, { prefix: "c/d/", delimiter: "/" })
      await list(s, "delimiter prefix e/", b, { prefix: "e/", delimiter: "/" })
      await list(s, "delimiter prefix e", b, { prefix: "e", delimiter: "/" })
      await list(s, "empty params", b, {
        prefix: "",
        delimiter: "",
        marker: "",
        "max-keys": "",
        "encoding-type": "",
      })
      await list(s, "list-type 1", b, { "list-type": "1", "max-keys": "3" })
      await list(s, "list-type 3", b, { "list-type": "3", "max-keys": "3" })
    },
  },
  {
    name: "v2-basics",
    async run(s) {
      const b = await s.bucket("list-v2")
      await putAll(s, b, TREE)
      await list(s, "all", b, v2())
      await list(s, "fetch-owner", b, v2({ "fetch-owner": "true", prefix: "b/" }))
      await list(s, "fetch-owner false", b, v2({ "fetch-owner": "false", prefix: "b/" }))
      await list(s, "fetch-owner TRUE", b, v2({ "fetch-owner": "TRUE", prefix: "b/" }))
      await list(s, "prefix c/", b, v2({ prefix: "c/" }))
      await list(s, "delimiter", b, v2({ delimiter: "/" }))
      await list(s, "delimiter prefix c/", b, v2({ prefix: "c/", delimiter: "/" }))
      await list(s, "delimiter prefix c/d", b, v2({ prefix: "c/d", delimiter: "/" }))
      await list(s, "delimiter prefix e/", b, v2({ prefix: "e/", delimiter: "/" }))
      await list(s, "with versions param", b, v2({ versions: "" }))
      await list(s, "metadata false", b, v2({ metadata: "false", prefix: "b/" }))
    },
  },
  {
    name: "max-keys",
    async run(s) {
      const b = await s.bucket("list-max")
      await putAll(s, b, ["a", "b", "c", "d/1", "d/2"])
      for (const value of [
        "0",
        "1",
        "2",
        "4",
        "5",
        "1000",
        "1001",
        "2147483647",
        "2147483648",
        "99999999999",
        "+3",
        "007",
        "-0",
      ])
        await list(s, `v1 ${value}`, b, { "max-keys": value })
      for (const value of [
        "-1",
        "abc",
        " 3",
        "3 ",
        "1.5",
        "0x10",
        "9223372036854775808",
        "-9223372036854775809",
      ])
        await list(s, `v1 invalid ${value}`, b, { "max-keys": value })
      for (const value of ["0", "1", "3", "1001"])
        await list(s, `v2 ${value}`, b, v2({ "max-keys": value }))
      await list(s, "v2 invalid", b, v2({ "max-keys": "-5" }))
      for (const value of ["0", "1", "3", "1001"])
        await list(s, `versions ${value}`, b, ver({ "max-keys": value }))
      await list(s, "versions invalid", b, ver({ "max-keys": "x" }))
      await list(s, "v1 delimiter 1", b, { "max-keys": "1", delimiter: "/" })
      await list(s, "v1 delimiter 3", b, { "max-keys": "3", delimiter: "/" })
      await list(s, "v1 delimiter 4", b, { "max-keys": "4", delimiter: "/" })
      await list(s, "v1 two max-keys", b, [
        ["max-keys", "1"],
        ["max-keys", "3"],
      ])
    },
  },
  {
    name: "v1-pagination",
    async run(s) {
      const b = await s.bucket("list-v1-page")
      await putAll(s, b, TREE)
      await paginate(s, "flat 2", b, "v1", { "max-keys": "2" })
      await paginate(s, "flat 5", b, "v1", { "max-keys": "5" })
      await paginate(s, "delimiter 2", b, "v1", { "max-keys": "2", delimiter: "/" })
      await paginate(s, "prefix c/ 1", b, "v1", { "max-keys": "1", prefix: "c/" })
    },
  },
  {
    name: "v2-pagination",
    async run(s) {
      const b = await s.bucket("list-v2-page")
      await putAll(s, b, TREE)
      await paginate(s, "flat 3", b, "v2", { "max-keys": "3" })
      await paginate(s, "delimiter 2", b, "v2", { "max-keys": "2", delimiter: "/" })
      await paginate(s, "delimiter 1 fetch-owner", b, "v2", {
        "max-keys": "1",
        delimiter: "/",
        "fetch-owner": "true",
      })
      await paginate(s, "start-after b/1 2", b, "v2", { "max-keys": "2", "start-after": "b/1" })
      await paginate(s, "prefix c/ 1", b, "v2", { "max-keys": "1", prefix: "c/" })
    },
  },
  {
    name: "v1-marker",
    async run(s) {
      const b = await s.bucket("list-marker")
      await putAll(s, b, TREE)
      await list(s, "existing key", b, { marker: "b/1" })
      await list(s, "between keys", b, { marker: "b/15" })
      await list(s, "before all", b, { marker: "0" })
      await list(s, "after all", b, { marker: "zzz" })
      await list(s, "is a prefix", b, { marker: "c/", delimiter: "/" })
      await list(s, "inside a prefix", b, { marker: "c/d", delimiter: "/" })
      await list(s, "inside a prefix deeper", b, { marker: "b/1", delimiter: "/" })
      await list(s, "under prefix", b, { prefix: "c/", marker: "c/d/e" })
      await list(s, "equal to prefix", b, { prefix: "c/", marker: "c/" })
      await list(s, "outside prefix after", b, { prefix: "b/", marker: "c" })
      await list(s, "outside prefix before", b, { prefix: "b/", marker: "a" })
      await list(s, "max-keys 0", b, { marker: "b/1", "max-keys": "0" })
      await list(s, "max-keys 1", b, { marker: "b/1", "max-keys": "1" })
      await list(s, "max-keys 1 missing key", b, { marker: "b/15", "max-keys": "1" })
      await list(s, "tagged marker", b, { marker: "b/1[minio_cache:v2,return:]", "max-keys": "2" })
      await list(s, "encoded", b, { marker: "b/1", "encoding-type": "url" })
    },
  },
  {
    name: "v2-start-after-and-tokens",
    async run(s) {
      const b = await s.bucket("list-start")
      await putAll(s, b, TREE)
      await list(s, "start-after key", b, v2({ "start-after": "b/2" }))
      await list(s, "start-after between", b, v2({ "start-after": "c/e" }))
      await list(s, "start-after past end", b, v2({ "start-after": "z" }))
      await list(s, "start-after before prefix", b, v2({ prefix: "c/", "start-after": "a" }))
      await list(
        s,
        "start-after before prefix max-keys 1",
        b,
        v2({ prefix: "c/", "start-after": "a", "max-keys": "1" }),
      )
      await list(s, "start-after after prefix", b, v2({ prefix: "c/", "start-after": "d" }))
      await list(s, "start-after inside prefix", b, v2({ prefix: "c/", "start-after": "c/d/e" }))
      await list(s, "start-after delimiter", b, v2({ "start-after": "c/d/e", delimiter: "/" }))
      await list(s, "start-after empty", b, v2({ "start-after": "" }))
      await list(
        s,
        "start-after encoded",
        b,
        v2({ "start-after": "b/1 x", "encoding-type": "url" }),
      )
      // continuation tokens are base64 of a marker: MinIO accepts any key.
      await list(s, "token plain key", b, v2({ "continuation-token": btoa("c/g") }))
      await list(
        s,
        "token wins over start-after",
        b,
        v2({ "continuation-token": btoa("e/"), "start-after": "a" }),
      )
      await list(
        s,
        "token outside prefix",
        b,
        v2({ "continuation-token": btoa("a"), prefix: "c/" }),
      )
      await list(
        s,
        "token under prefix",
        b,
        v2({ "continuation-token": btoa("c/d/e"), prefix: "c/" }),
      )
      await list(
        s,
        "token tagged",
        b,
        v2({ "continuation-token": btoa("b/1[minio_cache:v2,return:]"), "max-keys": "2" }),
      )
      await list(s, "token empty", b, v2({ "continuation-token": "" }))
      await list(s, "token not base64", b, v2({ "continuation-token": "!!!" }))
      await list(s, "token missing padding", b, v2({ "continuation-token": "Yg" }))
      await list(s, "token bad padding", b, v2({ "continuation-token": "Y===" }))
      await list(s, "token url-safe alphabet", b, v2({ "continuation-token": "-_-_" }))
      await list(
        s,
        "token empty and max-keys bad",
        b,
        v2({ "continuation-token": "", "max-keys": "x" }),
      )
      await list(
        s,
        "token bad and max-keys bad",
        b,
        v2({ "continuation-token": "!!", "max-keys": "x" }),
      )
      await list(
        s,
        "token bad and encoding bad",
        b,
        v2({ "continuation-token": "!!", "encoding-type": "x" }),
      )
    },
  },
  {
    name: "delimiters",
    async run(s) {
      const b = await s.bucket("list-delim")
      await putAll(s, b, [
        "a-1",
        "a-2",
        "a-3",
        "a/b",
        "ab",
        "abc-x",
        "b",
        "b::c",
        "b::d::e",
        "c%d",
        "c+d",
        "x.y.z",
      ])
      await list(s, "dash", b, { delimiter: "-" })
      await list(s, "dash v2", b, v2({ delimiter: "-" }))
      await list(s, "dash prefix", b, { delimiter: "-", prefix: "a" })
      await list(s, "multi-char", b, { delimiter: "::" })
      await list(s, "multi-char prefix", b, { delimiter: "::", prefix: "b::" })
      await list(s, "absent", b, { delimiter: "#" })
      await list(s, "whole key", b, { delimiter: "ab" })
      await list(s, "percent", b, { delimiter: "%" })
      await list(s, "plus", b, [["delimiter", "+"]])
      await list(s, "dot", b, { delimiter: "." })
      await list(s, "dot encoded", b, { delimiter: ".", "encoding-type": "url" })
      await list(s, "dot dot", b, { delimiter: ".." })
      await list(s, "dash max-keys 1", b, { delimiter: "-", "max-keys": "1" })
      await list(s, "dash max-keys 2", b, { delimiter: "-", "max-keys": "2" })
      await list(s, "dash max-keys 3", b, { delimiter: "-", "max-keys": "3" })
      await list(s, "dash marker a-", b, { delimiter: "-", "max-keys": "1", marker: "a-" })
      await list(s, "dash marker a-3", b, { delimiter: "-", "max-keys": "1", marker: "a-3" })
      await list(s, "dash v2 max-keys 2", b, v2({ delimiter: "-", "max-keys": "2" }))
      await list(s, "dash versions", b, ver({ delimiter: "-" }))
      await list(s, "dash versions max-keys 2", b, ver({ delimiter: "-", "max-keys": "2" }))
      await list(s, "slash versions", b, ver({ delimiter: "/" }))
    },
  },
  {
    name: "prefixes",
    async run(s) {
      const b = await s.bucket("list-prefix")
      await putAll(s, b, [
        "dir/",
        "dir/a",
        "dir/sub/",
        "dir/sub/b",
        "dirx",
        "photos/2024/jan.jpg",
        "photos/2024/feb.jpg",
        "photos/2025/mar.jpg",
      ])
      await list(s, "all", b)
      await list(s, "delimiter", b, { delimiter: "/" })
      await list(s, "dir/ delimiter", b, { prefix: "dir/", delimiter: "/" })
      await list(s, "dir/sub/ delimiter", b, { prefix: "dir/sub/", delimiter: "/" })
      await list(s, "dir delimiter", b, { prefix: "dir", delimiter: "/" })
      await list(s, "photos/ delimiter", b, v2({ prefix: "photos/", delimiter: "/" }))
      await list(s, "photos/2024/ delimiter", b, v2({ prefix: "photos/2024/", delimiter: "/" }))
      await list(s, "exact object max-keys 1", b, { prefix: "dirx", "max-keys": "1" })
      await list(s, "exact object max-keys 1 v2", b, v2({ prefix: "dir/a", "max-keys": "1" }))
      await list(s, "exact dir object max-keys 1", b, v2({ prefix: "dir/", "max-keys": "1" }))
      await list(s, "not an object max-keys 1", b, v2({ prefix: "dir", "max-keys": "1" }))
      await list(s, "exact object max-keys 2", b, { prefix: "dirx", "max-keys": "2" })
      await list(s, "leading slash", b, { prefix: "/dir" })
      await list(s, "double slash", b, { prefix: "dir//a" })
      await list(s, "double slash v2", b, v2({ prefix: "a//" }))
      await list(s, "double slash versions", b, ver({ prefix: "//" }))
      await list(s, "dot-dot segment", b, { prefix: "dir/../x" })
      await list(s, "dot segment", b, v2({ prefix: "./dir" }))
      await list(s, "trailing dot-dot", b, { prefix: "dir/.." })
      await list(s, "dots in name", b, { prefix: "dir/...", delimiter: "/" })
      await list(s, "delimiter with dot-dot", b, { delimiter: ".." })
    },
  },
  {
    name: "special-keys",
    async run(s) {
      const b = await s.bucket("list-special")
      await putAll(s, b, [
        "a b",
        "a+b",
        "a%b",
        "a&b<c>d\"e'f",
        "tilde~star*",
        "semi;colon,comma=eq?q#h",
        "café",
        "日本/語",
        "emoji-\u{1f600}",
        "private-",
        "zÿ",
        "Upper",
        "_under",
        "0digit",
        "tab\there",
      ])
      await list(s, "v1", b)
      await list(s, "v2", b, v2())
      await list(s, "versions", b, ver())
      await list(s, "v1 url", b, { "encoding-type": "url" })
      await list(s, "v1 URL", b, { "encoding-type": "URL" })
      await list(s, "v2 url", b, v2({ "encoding-type": "url" }))
      await list(s, "v2 Url delimiter", b, v2({ "encoding-type": "Url", delimiter: "/" }))
      await list(s, "versions url", b, ver({ "encoding-type": "url" }))
      await list(s, "invalid encoding", b, { "encoding-type": "base64" })
      await list(s, "invalid encoding v2", b, v2({ "encoding-type": "urls" }))
      await list(s, "invalid encoding versions", b, ver({ "encoding-type": "none" }))
      await list(s, "prefix space", b, { prefix: "a b" })
      await list(s, "prefix space url", b, { prefix: "a b", "encoding-type": "url" })
      await list(s, "prefix ampersand", b, v2({ prefix: "a&" }))
      await list(
        s,
        "prefix unicode url",
        b,
        v2({ prefix: "日", delimiter: "/", "encoding-type": "url" }),
      )
      await list(s, "marker unicode url", b, { marker: "café", "encoding-type": "url" })
      await list(s, "delimiter unicode", b, { delimiter: "本" })
      await list(s, "page through", b, { "max-keys": "4" })
      await paginate(s, "url pages", b, "v1", { "max-keys": "5", "encoding-type": "url" })
    },
  },
  {
    name: "versions-unversioned",
    async run(s) {
      const b = await s.bucket("list-ver-none")
      await putAll(s, b, ["a", "b/1", "b/2", "c"])
      await put(s, b, "a", "rewritten")
      await list(s, "all", b, ver())
      await list(s, "prefix", b, ver({ prefix: "b/" }))
      await list(s, "delimiter", b, ver({ delimiter: "/" }))
      await paginate(s, "max-keys 1", b, "versions", { "max-keys": "1" })
      await list(s, "key-marker", b, ver({ "key-marker": "b/1" }))
      await list(
        s,
        "key-marker and null version marker",
        b,
        ver({ "key-marker": "b/1", "version-id-marker": "null" }),
      )
      await list(
        s,
        "key-marker and unknown version marker",
        b,
        ver({ "key-marker": "b/1", "version-id-marker": "nope" }),
      )
      await list(s, "key-marker outside prefix", b, ver({ "key-marker": "c", prefix: "b/" }))
      await list(s, "key-marker max-keys 0", b, ver({ "key-marker": "a", "max-keys": "0" }))
      await list(s, "version marker alone", b, ver({ "version-id-marker": "null" }))
      await list(s, "empty version marker", b, ver({ "version-id-marker": "" }))
    },
  },
  {
    name: "versions-versioned",
    async run(s) {
      const b = await s.bucket("list-ver-on", { versioning: "Enabled" })
      await put(s, b, "a", "1")
      await put(s, b, "a", "22")
      await put(s, b, "a", "333")
      await put(s, b, "b/1", "x")
      await del(s, b, "b/1")
      await put(s, b, "c", "c")
      await del(s, b, "c")
      await put(s, b, "c", "cc")
      await put(s, b, "d", "d")
      await list(s, "all", b, ver())
      await list(s, "prefix a", b, ver({ prefix: "a" }))
      await list(s, "delimiter", b, ver({ delimiter: "/" }))
      await list(s, "v1 hides deleted keys", b)
      await list(s, "v1 delimiter keeps deleted prefix", b, { delimiter: "/" })
      await list(s, "v2 delimiter keeps deleted prefix", b, v2({ delimiter: "/" }))
      await list(s, "v2 prefix of deleted", b, v2({ prefix: "b/" }))
      await paginate(s, "max-keys 1", b, "versions", { "max-keys": "1" })
      await paginate(s, "max-keys 2", b, "versions", { "max-keys": "2" })
      await paginate(s, "max-keys 4", b, "versions", { "max-keys": "4" })
      const all = await s.raw({ method: "GET", path: keyPath(b), query: ver() })
      const ids = all.tags("VersionId")
      await list(
        s,
        "after newest of a",
        b,
        ver({ "key-marker": "a", "version-id-marker": ids[0] ?? "" }),
      )
      await list(
        s,
        "after oldest of a",
        b,
        ver({ "key-marker": "a", "version-id-marker": ids[2] ?? "" }),
      )
      await list(
        s,
        "version marker of another key",
        b,
        ver({ "key-marker": "a", "version-id-marker": ids[4] ?? "" }),
      )
      await list(
        s,
        "unknown version marker",
        b,
        ver({ "key-marker": "a", "version-id-marker": "00000000-0000-0000-0000-000000000000" }),
      )
      await list(s, "key-marker only", b, ver({ "key-marker": "a" }))
      await list(s, "key-marker missing key", b, ver({ "key-marker": "b" }))
      await list(
        s,
        "key-marker missing key with version",
        b,
        ver({ "key-marker": "b", "version-id-marker": ids[0] ?? "" }),
      )
      await list(
        s,
        "max-keys 0 with markers",
        b,
        ver({ "key-marker": "a", "version-id-marker": ids[0] ?? "", "max-keys": "0" }),
      )
      await list(s, "metadata", b, ver({ metadata: "true", prefix: "b/" }))
    },
  },
  {
    name: "versions-suspended",
    async run(s) {
      const b = await s.bucket("list-ver-sus", { versioning: "Enabled" })
      await put(s, b, "k", "v1")
      await versioning(s, b, "Suspended")
      await put(s, b, "k", "null one")
      await put(s, b, "k", "null two")
      await put(s, b, "n", "only null")
      await del(s, b, "n")
      await list(s, "all", b, ver())
      await paginate(s, "max-keys 1", b, "versions", { "max-keys": "1" })
      await list(s, "after null", b, ver({ "key-marker": "k", "version-id-marker": "null" }))
      await list(s, "v1", b)
      await list(s, "v2", b, v2())
    },
  },
  {
    name: "versions-null-before-enabling",
    async run(s) {
      const b = await s.bucket("list-ver-pre")
      await put(s, b, "k", "before")
      await versioning(s, b, "Enabled")
      await put(s, b, "k", "after")
      await list(s, "all", b, ver())
      await paginate(s, "max-keys 1", b, "versions", { "max-keys": "1" })
    },
  },
  {
    name: "metadata",
    async run(s) {
      const b = await s.bucket("list-meta")
      await put(s, b, "plain", "x", { "content-type": "text/plain" })
      await put(s, b, "meta", "x", {
        "content-type": "image/png",
        "x-amz-meta-color": "Blue",
        "x-amz-meta-Two-Words": "a b",
      })
      await put(s, b, "headers", "x", {
        "content-type": "text/html",
        "cache-control": "no-cache",
        "content-encoding": "identity",
        "content-disposition": "inline",
        "content-language": "en",
        expires: "Thu, 01 Dec 2094 16:00:00 GMT",
        "x-amz-website-redirect-location": "/elsewhere",
      })
      await put(s, b, "tagged", "x", { "content-type": "a/b", "x-amz-tagging": "k=v&a=b%20c" })
      await put(s, b, "rrs", "x", {
        "content-type": "a/b",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      })
      await put(s, b, "std", "x", { "content-type": "a/b", "x-amz-storage-class": "STANDARD" })
      await put(s, b, "xml", "x", { "content-type": "a/b", "x-amz-meta-x": "<&>\"'" })
      await list(s, "v2 metadata", b, v2({ metadata: "true" }))
      await list(
        s,
        "v2 metadata fetch-owner",
        b,
        v2({ metadata: "true", "fetch-owner": "true", prefix: "t" }),
      )
      await list(
        s,
        "v2 metadata delimiter",
        b,
        v2({ metadata: "true", delimiter: "e", "max-keys": "3" }),
      )
      await list(s, "v2 metadata TRUE is plain", b, v2({ metadata: "TRUE" }))
      await list(
        s,
        "v2 metadata url",
        b,
        v2({ metadata: "true", "encoding-type": "url", prefix: "m" }),
      )
      await list(s, "versions metadata", b, ver({ metadata: "true" }))
      await list(s, "v1 ignores metadata", b, { metadata: "true", prefix: "m" })
    },
  },
  {
    name: "metadata-default-content-type",
    async run(s) {
      const b = await s.bucket("list-meta-ct")
      await put(s, b, "none", "x")
      await list(s, "v2 metadata", b, v2({ metadata: "true" }))
    },
  },
  {
    name: "metadata-delete-markers",
    async run(s) {
      const b = await s.bucket("list-meta-dm", { versioning: "Enabled" })
      await put(s, b, "k", "x", { "content-type": "a/b", "x-amz-tagging": "t=1" })
      await del(s, b, "k")
      await list(s, "versions metadata", b, ver({ metadata: "true" }))
      await list(s, "v2 metadata", b, v2({ metadata: "true" }))
    },
  },
  {
    name: "sizes-and-etags",
    async run(s) {
      const b = await s.bucket("list-sizes")
      await put(s, b, "empty", "")
      await put(s, b, "big", "y".repeat(5000))
      await put(s, b, "quote", '"quoted"')
      await list(s, "v1", b)
      await list(s, "v2", b, v2())
      await list(s, "versions", b, ver())
    },
  },
  {
    name: "overwrite-and-delete",
    async run(s) {
      const b = await s.bucket("list-churn")
      await putAll(s, b, ["a", "b", "c/1", "c/2"])
      await put(s, b, "b", "changed")
      await del(s, b, "a")
      await del(s, b, "c/1")
      await list(s, "v1", b)
      await list(s, "v2 delimiter", b, v2({ delimiter: "/" }))
      await del(s, b, "c/2")
      await list(s, "v2 delimiter after emptying prefix", b, v2({ delimiter: "/" }))
      await list(s, "versions", b, ver())
    },
  },
  {
    name: "many-keys",
    async run(s) {
      const b = await s.bucket("list-many")
      const keys: string[] = []
      for (let index = 0; index < 30; index++) keys.push(`k/${String(index).padStart(3, "0")}`)
      for (let index = 0; index < 5; index++) keys.push(`p${index}/x`)
      await putAll(s, b, keys)
      await paginate(s, "v1 7", b, "v1", { "max-keys": "7" })
      await paginate(s, "v2 9 delimiter", b, "v2", { "max-keys": "9", delimiter: "/" })
      await paginate(s, "v2 3 prefix", b, "v2", { "max-keys": "3", prefix: "p" })
      await paginate(s, "versions 10", b, "versions", { "max-keys": "10" })
      await list(s, "v2 1000", b, v2({ "max-keys": "1000", delimiter: "/" }))
    },
  },
  {
    name: "skipped-entries",
    async run(s) {
      const b = await s.bucket("list-skip", { versioning: "Enabled" })
      await putAll(s, b, [
        "a",
        "b/1",
        "b/2",
        "c/d/e",
        "c/d/f",
        "c/g",
        "d1",
        "d2",
        "d3",
        "e",
        "f/x/y/z",
        "g",
      ])
      await del(s, b, "d1")
      await del(s, b, "d2")
      await del(s, b, "c/g")
      await list(s, "v1 marker missing key", b, { marker: "b/15", "max-keys": "1" })
      await list(s, "v1 marker before deleted run", b, { marker: "c/d/f", "max-keys": "1" })
      await list(s, "v1 marker missing before deleted run", b, { marker: "c/e", "max-keys": "1" })
      await list(s, "v1 marker missing before deep dirs", b, { marker: "e0", "max-keys": "1" })
      await list(s, "v2 start-after missing key", b, v2({ "start-after": "b/15", "max-keys": "1" }))
      await list(
        s,
        "v2 start-after before deleted",
        b,
        v2({ "start-after": "c/e", "max-keys": "2" }),
      )
      await list(s, "v1 delimiter marker missing", b, {
        marker: "b0",
        "max-keys": "1",
        delimiter: "/",
      })
      await paginate(s, "v1 flat 1", b, "v1", { "max-keys": "1" })
      await paginate(s, "v1 flat 3", b, "v1", { "max-keys": "3" })
      await paginate(s, "v1 delimiter 2", b, "v1", { "max-keys": "2", delimiter: "/" })
      await paginate(s, "v2 flat 2 start-after", b, "v2", {
        "max-keys": "2",
        "start-after": "b/15",
      })
      await paginate(s, "versions 3", b, "versions", { "max-keys": "3" })
      await paginate(s, "versions delimiter 2", b, "versions", { "max-keys": "2", delimiter: "/" })
    },
  },
  {
    name: "forged-markers",
    async run(s) {
      const b = await s.bucket("list-forged")
      await putAll(s, b, ["a", "b", "c", "d", "e"])
      await list(s, "tag without id", b, { marker: "b[minio_cache:v2]", "max-keys": "1" })
      await list(s, "old tag version", b, { marker: "b[minio_cache:v1,return:]", "max-keys": "1" })
      await list(s, "bad pool", b, { marker: "b[minio_cache:v2,p:x]", "max-keys": "1" })
      await list(s, "unknown id", b, {
        marker: "b[minio_cache:v2,id:00000000-0000-4000-8000-000000000000,p:0,s:0]",
        "max-keys": "1",
      })
      await list(s, "brackets in key", b, { marker: "b[x]", "max-keys": "1" })
      await list(
        s,
        "v2 token tag without id",
        b,
        v2({ "continuation-token": btoa("b[minio_cache:v2]"), "max-keys": "1" }),
      )
      await list(
        s,
        "versions return tag",
        b,
        ver({ "key-marker": "b[minio_cache:v2,return:]", "max-keys": "1" }),
      )
    },
  },
  {
    name: "versions-pagination-delimiter",
    async run(s) {
      const b = await s.bucket("list-ver-delim", { versioning: "Enabled" })
      for (const key of ["a", "p/1", "p/2", "q/1", "r"]) {
        await put(s, b, key, "1")
        await put(s, b, key, "22")
      }
      await del(s, b, "p/1")
      await paginate(s, "slash 1", b, "versions", { "max-keys": "1", delimiter: "/" })
      await paginate(s, "slash 3", b, "versions", { "max-keys": "3", delimiter: "/" })
      await paginate(s, "prefix p/ 1", b, "versions", { "max-keys": "1", prefix: "p/" })
      await list(s, "key-marker is a prefix", b, ver({ "key-marker": "p/", delimiter: "/" }))
      await list(s, "key-marker inside prefix", b, ver({ "key-marker": "p/1", delimiter: "/" }))
      await paginate(s, "url", b, "versions", { "max-keys": "2", "encoding-type": "url" })
    },
  },
  {
    name: "sdk",
    async run(s) {
      const b = await s.bucket("list-sdk")
      await putAll(s, b, ["a", "b/1", "b/2", "c d", "e&f"])
      const client = s.sdk()
      const strip = (value: ListObjectsV2CommandOutput | ListObjectsCommandOutput) => ({
        keys: value.Contents?.map((item) => [item.Key, item.Size, item.ETag]),
        prefixes: value.CommonPrefixes?.map((item) => item.Prefix),
        truncated: value.IsTruncated,
        count: "KeyCount" in value ? value.KeyCount : undefined,
      })
      s.record("v2", strip(await client.send(new ListObjectsV2Command({ Bucket: b }))))
      s.record(
        "v2 delimiter",
        strip(
          await client.send(new ListObjectsV2Command({ Bucket: b, Delimiter: "/", MaxKeys: 10 })),
        ),
      )
      let token: string | undefined
      const pages: unknown[] = []
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: b, MaxKeys: 2, ContinuationToken: token }),
        )
        pages.push(strip(page))
        token = page.NextContinuationToken
      } while (token)
      s.record("v2 pages", pages)
      s.record(
        "v1",
        strip(await client.send(new ListObjectsCommand({ Bucket: b, Delimiter: "/" }))),
      )
      const versions = await client.send(new ListObjectVersionsCommand({ Bucket: b }))
      s.record(
        "versions",
        versions.Versions?.map((item) => [item.Key, item.VersionId, item.IsLatest]),
      )
      s.record(
        "missing",
        await s.errorName(() =>
          client.send(new ListObjectsV2Command({ Bucket: s.name("list-sdk-missing") })),
        ),
      )
      s.record(
        "bad token",
        await s.errorName(() =>
          client.send(new ListObjectsV2Command({ Bucket: b, ContinuationToken: "!!" })),
        ),
      )
    },
  },
]
