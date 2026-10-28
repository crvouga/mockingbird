/** Object lock: bucket configuration, per-object retention and legal hold, and what they block. */
import { type Ctx, keyPath, type RequestSpec, type Scenario } from "../harness.js"
import { deleteBody, md5, multiDelete } from "./delete.js"
import { ABSENT_VERSION, versionOf } from "./versioning.js"

const XMLNS = "http://s3.amazonaws.com/doc/2006-03-01/"
const FAR = "2099-01-01T00:00:00Z"
const FARTHER = "2099-06-01T00:00:00.000Z"
const PAST = "2001-01-01T00:00:00Z"

const lockConfig = (rule?: string, enabled = "Enabled") =>
  `<ObjectLockConfiguration xmlns="${XMLNS}"><ObjectLockEnabled>${enabled}</ObjectLockEnabled>${rule ? `<Rule><DefaultRetention>${rule}</DefaultRetention></Rule>` : ""}</ObjectLockConfiguration>`
const retention = (mode?: string, until?: string) =>
  `<Retention xmlns="${XMLNS}">${mode !== undefined ? `<Mode>${mode}</Mode>` : ""}${until !== undefined ? `<RetainUntilDate>${until}</RetainUntilDate>` : ""}</Retention>`
const legalHold = (status: string, root = "LegalHold") =>
  `<${root} xmlns="${XMLNS}"><Status>${status}</Status></${root}>`

const withMd5 = (body: string, headers: Record<string, string> = {}) => ({
  body,
  headers: { "content-md5": md5(body), ...headers },
})

const putLock = (
  s: Ctx,
  step: string,
  bucket: string,
  body: string,
  headers?: Record<string, string>,
) =>
  s.req(step, {
    method: "PUT",
    path: keyPath(bucket),
    query: { "object-lock": "" },
    body,
    ...(headers ? { headers } : {}),
  })
const getLock = (s: Ctx, step: string, bucket: string) =>
  s.req(step, { method: "GET", path: keyPath(bucket), query: { "object-lock": "" } })

const objectReq = (
  bucket: string,
  key: string,
  sub: "retention" | "legal-hold",
  spec: Partial<RequestSpec> & { versionId?: string },
): RequestSpec => {
  const { versionId, ...rest } = spec
  return {
    method: "GET",
    path: keyPath(bucket, key),
    query: { [sub]: "", ...(versionId !== undefined ? { versionId } : {}) },
    ...rest,
  }
}

export const scenarios: Scenario[] = [
  {
    name: "config-on-plain-bucket",
    async run(s) {
      const b = await s.bucket("lock-plain")
      await getLock(s, "get on plain bucket", b)
      await putLock(s, "put on plain bucket", b, lockConfig())
      await putLock(s, "put invalid on plain bucket", b, lockConfig(undefined, "Disabled"))
      await getLock(s, "get on missing bucket", s.name("lock-nob"))
      await putLock(s, "put on missing bucket", s.name("lock-nob2"), lockConfig())
    },
  },
  {
    name: "config-lifecycle",
    async run(s) {
      const b = await s.bucket("lock-cfg", { objectLock: true })
      await getLock(s, "get initial", b)
      await putLock(s, "governance days", b, lockConfig("<Mode>GOVERNANCE</Mode><Days>3</Days>"))
      await getLock(s, "get governance days", b)
      await putLock(s, "compliance years", b, lockConfig("<Mode>COMPLIANCE</Mode><Years>2</Years>"))
      await getLock(s, "get compliance years", b)
      await putLock(s, "no rule clears", b, lockConfig())
      await getLock(s, "get cleared", b)
      await putLock(
        s,
        "no xmlns",
        b,
        "<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule><DefaultRetention><Mode>GOVERNANCE</Mode><Days>1</Days></DefaultRetention></Rule></ObjectLockConfiguration>",
      )
      await getLock(s, "get no xmlns", b)
      await putLock(
        s,
        "empty rule",
        b,
        `<ObjectLockConfiguration xmlns="${XMLNS}"><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule></Rule></ObjectLockConfiguration>`,
      )
      await getLock(s, "get after empty rule", b)
      await putLock(s, "reset", b, lockConfig())
    },
  },
  {
    name: "config-invalid",
    async run(s) {
      const b = await s.bucket("lock-cfgbad", { objectLock: true })
      await putLock(s, "disabled", b, lockConfig(undefined, "Disabled"))
      await putLock(
        s,
        "missing enabled",
        b,
        `<ObjectLockConfiguration xmlns="${XMLNS}"></ObjectLockConfiguration>`,
      )
      await putLock(s, "bad mode", b, lockConfig("<Mode>FOREVER</Mode><Days>1</Days>"))
      await putLock(s, "lowercase mode", b, lockConfig("<Mode>governance</Mode><Days>1</Days>"))
      await putLock(s, "no period", b, lockConfig("<Mode>GOVERNANCE</Mode>"))
      await putLock(
        s,
        "both periods",
        b,
        lockConfig("<Mode>GOVERNANCE</Mode><Days>1</Days><Years>1</Years>"),
      )
      await putLock(s, "zero days", b, lockConfig("<Mode>GOVERNANCE</Mode><Days>0</Days>"))
      await putLock(s, "zero years", b, lockConfig("<Mode>GOVERNANCE</Mode><Years>0</Years>"))
      await putLock(s, "too many days", b, lockConfig("<Mode>GOVERNANCE</Mode><Days>36501</Days>"))
      await putLock(s, "max days", b, lockConfig("<Mode>GOVERNANCE</Mode><Days>36500</Days>"))
      await putLock(s, "too many years", b, lockConfig("<Mode>GOVERNANCE</Mode><Years>101</Years>"))
      await putLock(s, "negative days", b, lockConfig("<Mode>GOVERNANCE</Mode><Days>-1</Days>"))
      await putLock(s, "text days", b, lockConfig("<Mode>GOVERNANCE</Mode><Days>ten</Days>"))
      await putLock(s, "empty days", b, lockConfig("<Mode>GOVERNANCE</Mode><Days></Days>"))
      await putLock(s, "no mode", b, lockConfig("<Days>1</Days>"))
      await putLock(s, "empty body", b, "")
      await putLock(s, "not xml", b, "lock it")
      await putLock(
        s,
        "truncated",
        b,
        `<ObjectLockConfiguration xmlns="${XMLNS}"><ObjectLockEnabled>Enabled`,
      )
      await putLock(
        s,
        "wrong root",
        b,
        `<LockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></LockConfiguration>`,
      )
      await getLock(s, "get unchanged", b)
    },
  },
  {
    name: "put-object-lock-headers",
    async run(s) {
      const plain = await s.bucket("lock-hdr-plain")
      await s.req("retention on plain bucket", {
        method: "PUT",
        path: keyPath(plain, "k"),
        body: "x",
        headers: {
          "x-amz-object-lock-mode": "GOVERNANCE",
          "x-amz-object-lock-retain-until-date": FAR,
        },
      })
      await s.req("legal hold on plain bucket", {
        method: "PUT",
        path: keyPath(plain, "k"),
        body: "x",
        headers: { "x-amz-object-lock-legal-hold": "ON" },
      })
      const b = await s.bucket("lock-hdr", { objectLock: true })
      const put = (step: string, headers: Record<string, string>, key = "k") =>
        s.req(step, { method: "PUT", path: keyPath(b, key), body: "data", headers })
      await put("mode only", { "x-amz-object-lock-mode": "GOVERNANCE" })
      await put("date only", { "x-amz-object-lock-retain-until-date": FAR })
      await put("bad mode", {
        "x-amz-object-lock-mode": "FOREVER",
        "x-amz-object-lock-retain-until-date": FAR,
      })
      await put("bad date", {
        "x-amz-object-lock-mode": "GOVERNANCE",
        "x-amz-object-lock-retain-until-date": "tomorrow",
      })
      await put("past date", {
        "x-amz-object-lock-mode": "GOVERNANCE",
        "x-amz-object-lock-retain-until-date": PAST,
      })
      await put("bad legal hold", { "x-amz-object-lock-legal-hold": "MAYBE" })
      await put("empty mode", {
        "x-amz-object-lock-mode": "",
        "x-amz-object-lock-retain-until-date": FAR,
      })
      const gov = await put(
        "governance",
        {
          "x-amz-object-lock-mode": "GOVERNANCE",
          "x-amz-object-lock-retain-until-date": FAR,
        },
        "gov",
      )
      await s.req("head governance", { method: "HEAD", path: keyPath(b, "gov") })
      await s.req("get governance", { method: "GET", path: keyPath(b, "gov") })
      await s.req("get retention", objectReq(b, "gov", "retention", {}))
      await s.req("get legal hold none", objectReq(b, "gov", "legal-hold", {}))
      await put(
        "lowercase mode with millis",
        {
          "x-amz-object-lock-mode": "governance",
          "x-amz-object-lock-retain-until-date": "2099-01-01T00:00:00.123Z",
        },
        "gov2",
      )
      await s.req("head lowercase", { method: "HEAD", path: keyPath(b, "gov2") })
      await put("legal hold on", { "x-amz-object-lock-legal-hold": "ON" }, "held")
      await s.req("head held", { method: "HEAD", path: keyPath(b, "held") })
      await s.req("get legal hold", objectReq(b, "held", "legal-hold", {}))
      await s.req("get retention none", objectReq(b, "held", "retention", {}))
      await put("legal hold lowercase off", { "x-amz-object-lock-legal-hold": "off" }, "nothold")
      await s.req("get legal hold off", objectReq(b, "nothold", "legal-hold", {}))
      await put(
        "both",
        {
          "x-amz-object-lock-legal-hold": "ON",
          "x-amz-object-lock-mode": "GOVERNANCE",
          "x-amz-object-lock-retain-until-date": FAR,
        },
        "both",
      )
      await s.req("head both", { method: "HEAD", path: keyPath(b, "both") })
      await s.req("delete latest makes marker", { method: "DELETE", path: keyPath(b, "gov") })
      await s.req("delete governance version", {
        method: "DELETE",
        path: keyPath(b, "gov"),
        query: { versionId: versionOf(gov) },
      })
    },
  },
  {
    name: "retention-api",
    async run(s) {
      const b = await s.bucket("lock-ret", { objectLock: true })
      const v1 = versionOf(await s.raw({ method: "PUT", path: keyPath(b, "k"), body: "one" }))
      const put = (
        step: string,
        body: string,
        extra: Partial<RequestSpec> & { versionId?: string } = {},
      ) =>
        s.req(step, objectReq(b, "k", "retention", { method: "PUT", ...withMd5(body), ...extra }))
      await s.req("get none", objectReq(b, "k", "retention", {}))
      await s.req(
        "put no md5",
        objectReq(b, "k", "retention", { method: "PUT", body: retention("GOVERNANCE", FAR) }),
      )
      await put("bad mode", retention("FOREVER", FAR))
      await put("mode without date", retention("GOVERNANCE"))
      await put("date without mode", retention(undefined, FAR))
      await put("past date", retention("GOVERNANCE", PAST))
      await put("bad date", retention("GOVERNANCE", "someday"))
      await put("lowercase mode", retention("governance", FAR))
      await put("malformed", "<Retention><Mode>GOVERNANCE</Mode>")
      await put(
        "wrong root",
        `<ObjectRetention><Mode>GOVERNANCE</Mode><RetainUntilDate>${FAR}</RetainUntilDate></ObjectRetention>`,
      )
      await put("empty", "")
      await put("governance", retention("GOVERNANCE", FAR))
      await s.req("get governance", objectReq(b, "k", "retention", {}))
      await s.req("get by version", objectReq(b, "k", "retention", { versionId: v1 }))
      await s.req("head", { method: "HEAD", path: keyPath(b, "k") })
      await put("extend", retention("GOVERNANCE", FARTHER))
      await s.req("get extended", objectReq(b, "k", "retention", {}))
      await put("shorten without bypass", retention("GOVERNANCE", FAR))
      await put("to compliance without bypass", retention("COMPLIANCE", FARTHER))
      await put("shorten with bypass", retention("GOVERNANCE", FAR), {
        headers: {
          "content-md5": md5(retention("GOVERNANCE", FAR)),
          "x-amz-bypass-governance-retention": "true",
        },
      })
      await s.req("get shortened", objectReq(b, "k", "retention", {}))
      await put("clear without bypass", retention())
      await put("clear with bypass", retention(), {
        headers: { "content-md5": md5(retention()), "x-amz-bypass-governance-retention": "true" },
      })
      await s.req("get cleared", objectReq(b, "k", "retention", {}))
      await s.req("head cleared", { method: "HEAD", path: keyPath(b, "k") })
      await put("absent version", retention("GOVERNANCE", FAR), { versionId: ABSENT_VERSION })
      await put("malformed version", retention("GOVERNANCE", FAR), { versionId: "xyz" })
      await s.req(
        "get absent version",
        objectReq(b, "k", "retention", { versionId: ABSENT_VERSION }),
      )
      await s.req("get missing key", objectReq(b, "missing", "retention", {}))
      await s.req(
        "put missing key",
        objectReq(b, "missing", "retention", {
          method: "PUT",
          ...withMd5(retention("GOVERNANCE", FAR)),
        }),
      )
      await s.raw({ method: "DELETE", path: keyPath(b, "k") })
      await s.req("get on delete marker", objectReq(b, "k", "retention", {}))
      await s.req(
        "put on delete marker",
        objectReq(b, "k", "retention", { method: "PUT", ...withMd5(retention("GOVERNANCE", FAR)) }),
      )
      await s.req("get on old version", objectReq(b, "k", "retention", { versionId: v1 }))
      const plain = await s.bucket("lock-ret-plain")
      await s.raw({ method: "PUT", path: keyPath(plain, "k"), body: "x" })
      await s.req("get on plain bucket", objectReq(plain, "k", "retention", {}))
      await s.req(
        "put on plain bucket",
        objectReq(plain, "k", "retention", {
          method: "PUT",
          ...withMd5(retention("GOVERNANCE", FAR)),
        }),
      )
      await s.req(
        "put on missing bucket",
        objectReq(s.name("lock-ret-nob"), "k", "retention", {
          method: "PUT",
          ...withMd5(retention("GOVERNANCE", FAR)),
        }),
      )
    },
  },
  {
    name: "legal-hold-api",
    async run(s) {
      const b = await s.bucket("lock-hold", { objectLock: true })
      const v1 = versionOf(await s.raw({ method: "PUT", path: keyPath(b, "k"), body: "one" }))
      const put = (
        step: string,
        body: string,
        extra: Partial<RequestSpec> & { versionId?: string } = {},
      ) =>
        s.req(step, objectReq(b, "k", "legal-hold", { method: "PUT", ...withMd5(body), ...extra }))
      await s.req("get none", objectReq(b, "k", "legal-hold", {}))
      await s.req(
        "put no md5",
        objectReq(b, "k", "legal-hold", { method: "PUT", body: legalHold("ON") }),
      )
      await s.req(
        "put wrong md5",
        objectReq(b, "k", "legal-hold", {
          method: "PUT",
          body: legalHold("ON"),
          headers: { "content-md5": md5("x") },
        }),
      )
      await put("bad status", legalHold("MAYBE"))
      await put("lowercase status", legalHold("on"))
      await put("empty status", legalHold(""))
      await put("other root", legalHold("ON", "ObjectLockLegalHold"))
      await put("wrong root", legalHold("ON", "Hold"))
      await put("unknown child", `<LegalHold><Status>ON</Status><Extra>1</Extra></LegalHold>`)
      await put("malformed", "<LegalHold><Status>ON</Status>")
      await put("empty", "")
      await put("on", legalHold("ON"))
      await s.req("get on", objectReq(b, "k", "legal-hold", {}))
      await s.req("head on", { method: "HEAD", path: keyPath(b, "k") })
      await s.req("delete held version", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { versionId: v1 },
      })
      await s.req("delete held version bypass", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { versionId: v1 },
        headers: { "x-amz-bypass-governance-retention": "true" },
      })
      await multiDelete(s, "multi delete held", b, deleteBody([{ key: "k", versionId: v1 }, "k"]))
      await put("off by version", legalHold("OFF"), { versionId: v1 })
      await s.req("get off", objectReq(b, "k", "legal-hold", { versionId: v1 }))
      await s.req("head off", { method: "HEAD", path: keyPath(b, "k"), query: { versionId: v1 } })
      await put("absent version", legalHold("ON"), { versionId: ABSENT_VERSION })
      await s.req("delete released", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { versionId: v1 },
      })
      await s.req("get missing", objectReq(b, "k", "legal-hold", { versionId: v1 }))
      const plain = await s.bucket("lock-hold-plain")
      await s.raw({ method: "PUT", path: keyPath(plain, "k"), body: "x" })
      await s.req("get on plain bucket", objectReq(plain, "k", "legal-hold", {}))
      await s.req(
        "put on plain bucket",
        objectReq(plain, "k", "legal-hold", { method: "PUT", ...withMd5(legalHold("ON")) }),
      )
    },
  },
  {
    name: "governance-deletes",
    async run(s) {
      const b = await s.bucket("lock-del", { objectLock: true })
      const headers = {
        "x-amz-object-lock-mode": "GOVERNANCE",
        "x-amz-object-lock-retain-until-date": FAR,
      }
      const v1 = versionOf(
        await s.raw({ method: "PUT", path: keyPath(b, "k"), body: "one", headers }),
      )
      const v2 = versionOf(
        await s.raw({ method: "PUT", path: keyPath(b, "j"), body: "two", headers }),
      )
      await s.req("delete locked version", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { versionId: v1 },
      })
      await s.req("delete locked bypass false", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { versionId: v1 },
        headers: { "x-amz-bypass-governance-retention": "false" },
      })
      await s.req("delete without version makes marker", {
        method: "DELETE",
        path: keyPath(b, "k"),
      })
      await s.req("overwrite locked key", { method: "PUT", path: keyPath(b, "k"), body: "new" })
      await multiDelete(
        s,
        "multi locked",
        b,
        deleteBody([{ key: "k", versionId: v1 }, { key: "j", versionId: v2 }, "j"]),
      )
      await multiDelete(s, "multi locked bypass", b, deleteBody([{ key: "j", versionId: v2 }]), {
        "x-amz-bypass-governance-retention": "true",
      })
      await s.req("delete with bypass", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { versionId: v1 },
        headers: { "x-amz-bypass-governance-retention": "TRUE" },
      })
      await s.req("gone", { method: "GET", path: keyPath(b, "k"), query: { versionId: v1 } })
      await s.req("force delete on lock bucket", {
        method: "DELETE",
        path: keyPath(b, "k"),
        headers: { "x-minio-force-delete": "true" },
      })
    },
  },
  {
    name: "default-retention",
    async run(s) {
      const b = await s.bucket("lock-def", { objectLock: true })
      await s.raw({
        method: "PUT",
        path: keyPath(b),
        query: { "object-lock": "" },
        body: lockConfig("<Mode>GOVERNANCE</Mode><Days>1</Days>"),
      })
      const v = versionOf(
        await s.req("put inherits", { method: "PUT", path: keyPath(b, "k"), body: "x" }),
      )
      await s.req("head inherits", { method: "HEAD", path: keyPath(b, "k") })
      await s.req("get retention inherited", objectReq(b, "k", "retention", {}))
      await s.req("delete inherited", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { versionId: v },
      })
      await s.req("explicit wins", {
        method: "PUT",
        path: keyPath(b, "e"),
        body: "x",
        headers: {
          "x-amz-object-lock-mode": "GOVERNANCE",
          "x-amz-object-lock-retain-until-date": FAR,
        },
      })
      await s.req("head explicit", { method: "HEAD", path: keyPath(b, "e") })
      await s.req("legal hold skips default", {
        method: "PUT",
        path: keyPath(b, "h"),
        body: "x",
        headers: { "x-amz-object-lock-legal-hold": "OFF" },
      })
      await s.req("head legal hold only", { method: "HEAD", path: keyPath(b, "h") })
      await s.req("get retention legal hold only", objectReq(b, "h", "retention", {}))
    },
  },
  {
    name: "compliance-rejections",
    async run(s) {
      const b = await s.bucket("lock-comp", { objectLock: true })
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: "x" })
      await s.req("compliance past date header", {
        method: "PUT",
        path: keyPath(b, "c"),
        body: "x",
        headers: {
          "x-amz-object-lock-mode": "COMPLIANCE",
          "x-amz-object-lock-retain-until-date": PAST,
        },
      })
      await s.req(
        "compliance past date api",
        objectReq(b, "k", "retention", {
          method: "PUT",
          ...withMd5(retention("COMPLIANCE", PAST)),
        }),
      )
    },
  },
]
