/** config/: lifecycle, encryption, notification and replication configuration scenarios. */
import { checksums } from "../../client.js"
import { type Ctx, keyPath, type Scenario } from "../../harness.js"

const NS = "http://s3.amazonaws.com/doc/2006-03-01/"
const encoder = new TextEncoder()
const md5 = (body: string) => checksums.md5(encoder.encode(body))

const lifecycle = (rules: string, root = "LifecycleConfiguration", xmlns = true) =>
  `<${root}${xmlns ? ` xmlns="${NS}"` : ""}>${rules}</${root}>`
const rule = (inner: string, id = "r1", status = "Enabled") =>
  `<Rule><ID>${id}</ID><Status>${status}</Status>${inner}</Rule>`
const expireDays = (days: string | number) => `<Expiration><Days>${days}</Days></Expiration>`

/** PUT ?lifecycle with a correct Content-MD5 (MinIO requires it). */
const putLifecycle = (s: Ctx, step: string, bucket: string, body: string, headers = {}) =>
  s.req(step, {
    method: "PUT",
    path: keyPath(bucket),
    query: { lifecycle: "" },
    body,
    headers: { "content-md5": md5(body), ...headers },
  })
const getLifecycle = (s: Ctx, step: string, bucket: string, query: Record<string, string> = {}) =>
  s.req(step, { method: "GET", path: keyPath(bucket), query: { lifecycle: "", ...query } })

/** PUT then GET, so the stored (re-marshalled) form is recorded. */
const roundTrip = async (s: Ctx, step: string, bucket: string, body: string) => {
  await putLifecycle(s, `put ${step}`, bucket, body)
  await getLifecycle(s, `get ${step}`, bucket)
}

const sse = (inner: string) =>
  `<ServerSideEncryptionConfiguration xmlns="${NS}">${inner}</ServerSideEncryptionConfiguration>`
const sseRule = (algorithm: string, key?: string) =>
  `<Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>${algorithm}</SSEAlgorithm>${key === undefined ? "" : `<KMSMasterKeyID>${key}</KMSMasterKeyID>`}</ApplyServerSideEncryptionByDefault></Rule>`

const notification = (inner: string) =>
  `<NotificationConfiguration xmlns="${NS}">${inner}</NotificationConfiguration>`
const queue = (arn: string, events: string[], extra = "") =>
  `<QueueConfiguration><Id>q1</Id>${extra}<Queue>${arn}</Queue>${events.map((name) => `<Event>${name}</Event>`).join("")}</QueueConfiguration>`

const replicationConfig = (rules: string, role = "") =>
  `<ReplicationConfiguration xmlns="${NS}">${role}${rules}</ReplicationConfiguration>`
const replicationRule = (inner = "") =>
  `<Rule><ID>rep1</ID><Status>Enabled</Status><Priority>1</Priority><DeleteMarkerReplication><Status>Disabled</Status></DeleteMarkerReplication><Filter><Prefix></Prefix></Filter><Destination><Bucket>arn:aws:s3:::target</Bucket></Destination>${inner}</Rule>`

export const scenarios: Scenario[] = [
  // ── lifecycle ────────────────────────────────────────────────────────────
  {
    name: "lifecycle-none-and-missing-bucket",
    async run(s) {
      const b = await s.bucket("lcnone")
      const missing = s.name("lcmissing")
      await getLifecycle(s, "get none", b)
      await s.req("delete none", { method: "DELETE", path: keyPath(b), query: { lifecycle: "" } })
      await getLifecycle(s, "get missing bucket", missing)
      await s.req("delete missing bucket", {
        method: "DELETE",
        path: keyPath(missing),
        query: { lifecycle: "" },
      })
      await putLifecycle(s, "put missing bucket", missing, lifecycle(rule(expireDays(1))))
      await s.req("put missing bucket without md5", {
        method: "PUT",
        path: keyPath(missing),
        query: { lifecycle: "" },
        body: lifecycle(rule(expireDays(1))),
      })
    },
  },
  {
    name: "lifecycle-content-md5",
    async run(s) {
      const b = await s.bucket("lcmd5")
      const body = lifecycle(rule(expireDays(1)))
      await s.req("no md5", { method: "PUT", path: keyPath(b), query: { lifecycle: "" }, body })
      await s.req("bad base64 md5", {
        method: "PUT",
        path: keyPath(b),
        query: { lifecycle: "" },
        body,
        headers: { "content-md5": "%%%" },
      })
      await s.req("wrong md5", {
        method: "PUT",
        path: keyPath(b),
        query: { lifecycle: "" },
        body,
        headers: { "content-md5": md5("something else") },
      })
      await s.req("crc32 checksum instead", {
        method: "PUT",
        path: keyPath(b),
        query: { lifecycle: "" },
        body,
        headers: { "x-amz-checksum-crc32": checksums.crc32(encoder.encode(body)) },
      })
      await getLifecycle(s, "get after crc32", b)
      await s.req("delete", { method: "DELETE", path: keyPath(b), query: { lifecycle: "" } })
      await getLifecycle(s, "get after delete", b)
    },
  },
  {
    name: "lifecycle-round-trip-forms",
    async run(s) {
      const b = await s.bucket("lcforms")
      await roundTrip(
        s,
        "filter prefix",
        b,
        lifecycle(rule(`<Filter><Prefix>logs/</Prefix></Filter>${expireDays(30)}`)),
      )
      await roundTrip(
        s,
        "legacy prefix",
        b,
        lifecycle(rule(`<Prefix>tmp/</Prefix>${expireDays(7)}`)),
      )
      await roundTrip(s, "empty filter", b, lifecycle(rule(`<Filter></Filter>${expireDays(1)}`)))
      await roundTrip(s, "no filter", b, lifecycle(rule(expireDays(1))))
      await roundTrip(
        s,
        "filter tag",
        b,
        lifecycle(
          rule(`<Filter><Tag><Key>env</Key><Value>dev</Value></Tag></Filter>${expireDays(2)}`),
        ),
      )
      await roundTrip(
        s,
        "filter tag empty value",
        b,
        lifecycle(
          rule(`<Filter><Tag><Key>env</Key><Value></Value></Tag></Filter>${expireDays(2)}`),
        ),
      )
      await roundTrip(
        s,
        "filter and",
        b,
        lifecycle(
          rule(
            `<Filter><And><Prefix>p/</Prefix><Tag><Key>a</Key><Value>1</Value></Tag><Tag><Key>b</Key><Value>2</Value></Tag><ObjectSizeGreaterThan>10</ObjectSizeGreaterThan><ObjectSizeLessThan>1000</ObjectSizeLessThan></And></Filter>${expireDays(3)}`,
          ),
        ),
      )
      await roundTrip(
        s,
        "filter sizes",
        b,
        lifecycle(
          rule(`<Filter><ObjectSizeLessThan>500</ObjectSizeLessThan></Filter>${expireDays(3)}`),
        ),
      )
      await roundTrip(
        s,
        "expiration date",
        b,
        lifecycle(rule("<Expiration><Date>2099-01-01T00:00:00Z</Date></Expiration>")),
      )
      await roundTrip(
        s,
        "expiration date with millis",
        b,
        lifecycle(rule("<Expiration><Date>2099-01-01T00:00:00.000Z</Date></Expiration>")),
      )
      await roundTrip(
        s,
        "expired delete marker",
        b,
        lifecycle(
          rule(
            "<Expiration><ExpiredObjectDeleteMarker>true</ExpiredObjectDeleteMarker></Expiration>",
          ),
        ),
      )
      await roundTrip(
        s,
        "expired delete marker false",
        b,
        lifecycle(
          rule(
            "<Expiration><ExpiredObjectDeleteMarker>false</ExpiredObjectDeleteMarker></Expiration>",
          ),
        ),
      )
      await roundTrip(
        s,
        "all versions",
        b,
        lifecycle(
          rule(
            "<Expiration><Days>5</Days><ExpiredObjectAllVersions>true</ExpiredObjectAllVersions></Expiration>",
          ),
        ),
      )
      await roundTrip(
        s,
        "noncurrent",
        b,
        lifecycle(
          rule(
            "<NoncurrentVersionExpiration><NoncurrentDays>4</NoncurrentDays><NewerNoncurrentVersions>2</NewerNoncurrentVersions></NoncurrentVersionExpiration>",
          ),
        ),
      )
      await roundTrip(
        s,
        "noncurrent max versions alias",
        b,
        lifecycle(
          rule(
            "<NoncurrentVersionExpiration><MaxNoncurrentVersions>3</MaxNoncurrentVersions></NoncurrentVersionExpiration>",
          ),
        ),
      )
      await roundTrip(
        s,
        "del marker expiration",
        b,
        lifecycle(rule("<DelMarkerExpiration><Days>9</Days></DelMarkerExpiration>")),
      )
      await roundTrip(s, "disabled", b, lifecycle(rule(expireDays(1), "off", "Disabled")))
      await roundTrip(
        s,
        "two rules and special chars",
        b,
        lifecycle(
          rule(
            `<Filter><Prefix>a&amp;b &lt;c&gt; "q" 'é'</Prefix></Filter>${expireDays(1)}`,
            "first &amp; &lt;one&gt;",
          ) + rule(expireDays(2), "second"),
        ),
      )
      await roundTrip(
        s,
        "bucket lifecycle root without namespace",
        b,
        lifecycle(rule(expireDays(6)), "BucketLifecycleConfiguration", false),
      )
      await roundTrip(
        s,
        "whitespace and unknown rule child",
        b,
        lifecycle(
          `\n  <Rule>\n <ID>ws</ID>\n <Status>Enabled</Status>\n <Bogus>1</Bogus>\n <Expiration>\n <Days> 12 </Days>\n </Expiration>\n </Rule>\n`,
        ),
      )
      await getLifecycle(s, "get withUpdatedAt=false", b, { withUpdatedAt: "false" })
      await getLifecycle(s, "get withUpdatedAt invalid", b, { withUpdatedAt: "maybe" })
      await getLifecycle(s, "get withUpdatedAt invalid missing bucket", s.name("lcnob"), {
        withUpdatedAt: "maybe",
      })
    },
  },
  {
    name: "lifecycle-generated-id",
    async run(s) {
      const b = await s.bucket("lcid")
      await putLifecycle(
        s,
        "put without id",
        b,
        lifecycle(`<Rule><Status>Enabled</Status>${expireDays(1)}</Rule>`),
      )
      const got = await s.raw({ method: "GET", path: keyPath(b), query: { lifecycle: "" } })
      const id = got.tag("ID") ?? ""
      s.record(
        "generated id is a uuid",
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id),
      )
      s.record("body with id masked", got.text.replace(id, "<uuid>"))
      await putLifecycle(
        s,
        "put with empty id",
        b,
        lifecycle(`<Rule><ID></ID><Status>Enabled</Status>${expireDays(1)}</Rule>`),
      )
      const again = await s.raw({ method: "GET", path: keyPath(b), query: { lifecycle: "" } })
      s.record("empty id replaced", (again.tag("ID") ?? "").length)
    },
  },
  {
    name: "lifecycle-validation-errors",
    async run(s) {
      const b = await s.bucket("lcerr")
      const cases: [string, string][] = [
        ["no rules", lifecycle("")],
        ["empty status", lifecycle(rule(expireDays(1), "r1", ""))],
        ["no status element", lifecycle(`<Rule><ID>x</ID>${expireDays(1)}</Rule>`)],
        ["invalid status", lifecycle(rule(expireDays(1), "r1", "enabled"))],
        ["days zero", lifecycle(rule(expireDays(0)))],
        ["days negative", lifecycle(rule(expireDays(-1)))],
        ["days empty", lifecycle(rule(expireDays("")))],
        ["days not a number", lifecycle(rule(expireDays("abc")))],
        ["days too big", lifecycle(rule(expireDays("99999999999999999999")))],
        [
          "date not midnight",
          lifecycle(rule("<Expiration><Date>2099-01-01T10:00:00Z</Date></Expiration>")),
        ],
        ["date not iso", lifecycle(rule("<Expiration><Date>2099-01-01</Date></Expiration>"))],
        [
          "days and date",
          lifecycle(
            rule("<Expiration><Days>1</Days><Date>2099-01-01T00:00:00Z</Date></Expiration>"),
          ),
        ],
        ["empty expiration", lifecycle(rule("<Expiration></Expiration>"))],
        [
          "delete marker with days",
          lifecycle(
            rule(
              "<Expiration><Days>1</Days><ExpiredObjectDeleteMarker>true</ExpiredObjectDeleteMarker></Expiration>",
            ),
          ),
        ],
        [
          "delete marker bad bool",
          lifecycle(
            rule(
              "<Expiration><ExpiredObjectDeleteMarker>yes</ExpiredObjectDeleteMarker></Expiration>",
            ),
          ),
        ],
        [
          "all versions without days",
          lifecycle(
            rule(
              "<Expiration><ExpiredObjectAllVersions>true</ExpiredObjectAllVersions></Expiration>",
            ),
          ),
        ],
        ["no action", lifecycle(rule("<Filter><Prefix>a</Prefix></Filter>"))],
        ["id too long", lifecycle(rule(expireDays(1), "x".repeat(256)))],
        ["id 255", lifecycle(rule(expireDays(1), "y".repeat(255)))],
        ["duplicate ids", lifecycle(rule(expireDays(1), "same") + rule(expireDays(2), "same"))],
        [
          "prefix and filter prefix",
          lifecycle(rule(`<Prefix>a</Prefix><Filter><Prefix>b</Prefix></Filter>${expireDays(1)}`)),
        ],
        [
          "prefix and filter tag",
          lifecycle(
            rule(
              `<Prefix>a</Prefix><Filter><Tag><Key>k</Key><Value>v</Value></Tag></Filter>${expireDays(1)}`,
            ),
          ),
        ],
        [
          "filter prefix and tag",
          lifecycle(
            rule(
              `<Filter><Prefix>a</Prefix><Tag><Key>k</Key><Value>v</Value></Tag></Filter>${expireDays(1)}`,
            ),
          ),
        ],
        [
          "filter unknown child",
          lifecycle(rule(`<Filter><Bogus>a</Bogus></Filter>${expireDays(1)}`)),
        ],
        [
          "filter and single predicate",
          lifecycle(rule(`<Filter><And><Prefix>a</Prefix></And></Filter>${expireDays(1)}`)),
        ],
        [
          "filter and duplicate tags",
          lifecycle(
            rule(
              `<Filter><And><Tag><Key>k</Key><Value>1</Value></Tag><Tag><Key>k</Key><Value>2</Value></Tag></And></Filter>${expireDays(1)}`,
            ),
          ),
        ],
        [
          "filter and empty tag key",
          lifecycle(
            rule(
              `<Filter><And><Prefix>a</Prefix><Tag><Key></Key><Value>2</Value></Tag></And></Filter>${expireDays(1)}`,
            ),
          ),
        ],
        [
          "tag key too long",
          lifecycle(
            rule(
              `<Filter><Tag><Key>${"k".repeat(129)}</Key><Value>v</Value></Tag></Filter>${expireDays(1)}`,
            ),
          ),
        ],
        [
          "tag value too long",
          lifecycle(
            rule(
              `<Filter><Tag><Key>k</Key><Value>${"v".repeat(257)}</Value></Tag></Filter>${expireDays(1)}`,
            ),
          ),
        ],
        [
          "tag duplicated key element",
          lifecycle(rule(`<Filter><Tag><Key>k</Key><Key>j</Key></Tag></Filter>${expireDays(1)}`)),
        ],
        [
          "tag unknown element",
          lifecycle(
            rule(`<Filter><Tag><Key>k</Key><Bogus>j</Bogus></Tag></Filter>${expireDays(1)}`),
          ),
        ],
        [
          "negative size",
          lifecycle(
            rule(`<Filter><ObjectSizeLessThan>-5</ObjectSizeLessThan></Filter>${expireDays(1)}`),
          ),
        ],
        [
          "noncurrent zero",
          lifecycle(
            rule(
              "<NoncurrentVersionExpiration><NoncurrentDays>0</NoncurrentDays></NoncurrentVersionExpiration>",
            ),
          ),
        ],
        [
          "noncurrent empty",
          lifecycle(rule("<NoncurrentVersionExpiration></NoncurrentVersionExpiration>")),
        ],
        [
          "noncurrent negative newer",
          lifecycle(
            rule(
              "<NoncurrentVersionExpiration><NoncurrentDays>1</NoncurrentDays><NewerNoncurrentVersions>-1</NewerNoncurrentVersions></NoncurrentVersionExpiration>",
            ),
          ),
        ],
        [
          "transition without tier",
          lifecycle(
            rule("<Transition><Days>1</Days><StorageClass>WARM</StorageClass></Transition>"),
          ),
        ],
        [
          "transition without storage class",
          lifecycle(rule("<Transition><Days>1</Days></Transition>")),
        ],
        [
          "transition days and date",
          lifecycle(
            rule(
              "<Transition><Days>1</Days><Date>2099-01-01T00:00:00Z</Date><StorageClass>WARM</StorageClass></Transition>",
            ),
          ),
        ],
        [
          "transition negative days",
          lifecycle(
            rule("<Transition><Days>-1</Days><StorageClass>WARM</StorageClass></Transition>"),
          ),
        ],
        [
          "noncurrent transition without tier",
          lifecycle(
            rule(
              "<NoncurrentVersionTransition><NoncurrentDays>1</NoncurrentDays><StorageClass>WARM</StorageClass></NoncurrentVersionTransition>",
            ),
          ),
        ],
        [
          "noncurrent transition without class",
          lifecycle(
            rule(
              "<NoncurrentVersionTransition><NoncurrentDays>1</NoncurrentDays></NoncurrentVersionTransition>",
            ),
          ),
        ],
        [
          "del marker zero",
          lifecycle(rule("<DelMarkerExpiration><Days>0</Days></DelMarkerExpiration>")),
        ],
        [
          "del marker with tag filter",
          lifecycle(
            rule(
              "<Filter><Tag><Key>k</Key><Value>v</Value></Tag></Filter><DelMarkerExpiration><Days>1</Days></DelMarkerExpiration>",
            ),
          ),
        ],
        ["wrong root", "<Lifecycle><Rule><ID>a</ID></Rule></Lifecycle>"],
        ["unknown top-level child", lifecycle(`<Bogus></Bogus>${rule(expireDays(1))}`)],
        ["truncated", `<LifecycleConfiguration><Rule><ID>a</ID>`],
        ["not xml", "hello"],
        ["empty body", ""],
        ["first error wins", lifecycle(rule(expireDays(0), "a", "bad"))],
        ["days whitespace only", lifecycle(rule(expireDays(" ")))],
        ["days plus sign", lifecycle(rule(expireDays("+3"), "plus"))],
        [
          "date day out of range",
          lifecycle(rule("<Expiration><Date>2099-02-30T00:00:00Z</Date></Expiration>")),
        ],
        [
          "date with offset",
          lifecycle(rule("<Expiration><Date>2099-01-01T00:00:00+00:00</Date></Expiration>")),
        ],
        ["unknown entity", lifecycle(rule(expireDays(1), "&bogus;"))],
        ["mismatched close", "<LifecycleConfiguration><Rule></Rules></LifecycleConfiguration>"],
        ["multi-line truncated", "<LifecycleConfiguration>\n<Rule>\n<ID>a</ID>\n"],
        [
          "comment and prolog",
          `<?xml version="1.0"?><!-- c -->${lifecycle(rule(expireDays(4), "c"))}`,
        ],
        ["self-closing filter", lifecycle(rule(`<Filter/>${expireDays(1)}`, "sc"))],
        ["cdata id", lifecycle(rule(expireDays(1), "<![CDATA[x<y]]>"))],
      ]
      for (const [step, body] of cases) await putLifecycle(s, step, b, body)
      await getLifecycle(s, "nothing stored", b)
    },
  },
  {
    name: "lifecycle-object-lock-bucket",
    async run(s) {
      const b = await s.bucket("lclock", { objectLock: true })
      await putLifecycle(
        s,
        "all versions on locked",
        b,
        lifecycle(
          rule(
            "<Expiration><Days>5</Days><ExpiredObjectAllVersions>true</ExpiredObjectAllVersions></Expiration>",
          ),
        ),
      )
      await putLifecycle(
        s,
        "del marker expiration on locked",
        b,
        lifecycle(rule("<DelMarkerExpiration><Days>3</Days></DelMarkerExpiration>")),
      )
      await roundTrip(s, "plain expiration on locked", b, lifecycle(rule(expireDays(5))))
    },
  },
  {
    name: "lifecycle-replace",
    async run(s) {
      const b = await s.bucket("lcreplace")
      await roundTrip(s, "first", b, lifecycle(rule(expireDays(1), "a") + rule(expireDays(2), "b")))
      await roundTrip(s, "second replaces", b, lifecycle(rule(expireDays(3), "c")))
      await s.req("delete", { method: "DELETE", path: keyPath(b), query: { lifecycle: "" } })
      await getLifecycle(s, "gone", b)
    },
  },

  // ── encryption ───────────────────────────────────────────────────────────
  {
    name: "encryption-without-kms",
    async run(s) {
      const b = await s.bucket("sse")
      const missing = s.name("ssemissing")
      const put = (step: string, bucket: string, body: string) =>
        s.req(step, { method: "PUT", path: keyPath(bucket), query: { encryption: "" }, body })
      await s.req("get none", { method: "GET", path: keyPath(b), query: { encryption: "" } })
      await put("aes256", b, sse(sseRule("AES256")))
      await put("aws:kms with key", b, sse(sseRule("aws:kms", "my-key")))
      await put("aws:kms arn key", b, sse(sseRule("aws:kms", "arn:aws:kms:my-key")))
      await put("aws:kms without key", b, sse(sseRule("aws:kms")))
      await put("aws:kms key with spaces", b, sse(sseRule("aws:kms", " my-key")))
      await put("aes256 with key", b, sse(sseRule("AES256", "k")))
      await put("unknown algorithm", b, sse(sseRule("DES")))
      await put(
        "no algorithm",
        b,
        sse(
          "<Rule><ApplyServerSideEncryptionByDefault></ApplyServerSideEncryptionByDefault></Rule>",
        ),
      )
      await put("no rules", b, sse(""))
      await put("two rules", b, sse(sseRule("AES256") + sseRule("AES256")))
      await put("wrong root", b, `<Encryption>${sseRule("AES256")}</Encryption>`)
      await put("truncated", b, "<ServerSideEncryptionConfiguration><Rule>")
      await put("empty body", b, "")
      await put(
        "no namespace",
        b,
        `<ServerSideEncryptionConfiguration>${sseRule("AES256")}</ServerSideEncryptionConfiguration>`,
      )
      await s.req("get still none", { method: "GET", path: keyPath(b), query: { encryption: "" } })
      await s.req("delete none", { method: "DELETE", path: keyPath(b), query: { encryption: "" } })
      await s.req("get missing bucket", {
        method: "GET",
        path: keyPath(missing),
        query: { encryption: "" },
      })
      await put("put missing bucket", missing, sse(sseRule("AES256")))
      await s.req("delete missing bucket", {
        method: "DELETE",
        path: keyPath(missing),
        query: { encryption: "" },
      })
    },
  },

  // ── notification ─────────────────────────────────────────────────────────
  {
    name: "notification-get-and-empty-put",
    async run(s) {
      const b = await s.bucket("notif")
      const missing = s.name("notifmissing")
      await s.req("get default", { method: "GET", path: keyPath(b), query: { notification: "" } })
      await s.req("put empty", {
        method: "PUT",
        path: keyPath(b),
        query: { notification: "" },
        body: notification(""),
      })
      await s.req("get after empty", {
        method: "GET",
        path: keyPath(b),
        query: { notification: "" },
      })
      await s.req("put empty no namespace", {
        method: "PUT",
        path: keyPath(b),
        query: { notification: "" },
        body: "<NotificationConfiguration></NotificationConfiguration>",
      })
      await s.req("get after no namespace", {
        method: "GET",
        path: keyPath(b),
        query: { notification: "" },
      })
      await s.req("get missing bucket", {
        method: "GET",
        path: keyPath(missing),
        query: { notification: "" },
      })
      await s.req("put missing bucket", {
        method: "PUT",
        path: keyPath(missing),
        query: { notification: "" },
        body: notification(""),
      })
      await s.req("put empty body", {
        method: "PUT",
        path: keyPath(b),
        query: { notification: "" },
      })
    },
  },
  {
    name: "notification-put-errors",
    async run(s) {
      const b = await s.bucket("notiferr")
      const put = (step: string, body: string) =>
        s.req(step, { method: "PUT", path: keyPath(b), query: { notification: "" }, body })
      const arn = "arn:minio:sqs::1:webhook"
      await put("unknown arn", notification(queue(arn, ["s3:ObjectCreated:*"])))
      await put(
        "unknown arn with region",
        notification(queue("arn:minio:sqs:us-east-1:1:webhook", ["s3:ObjectCreated:Put"])),
      )
      await put(
        "other region",
        notification(queue("arn:minio:sqs:eu-west-1:1:webhook", ["s3:ObjectCreated:Put"])),
      )
      await put(
        "aws arn",
        notification(queue("arn:aws:sqs:us-east-1:1:q", ["s3:ObjectCreated:Put"])),
      )
      await put("arn too short", notification(queue("arn:minio:sqs::1", ["s3:ObjectCreated:Put"])))
      await put(
        "arn empty name",
        notification(queue("arn:minio:sqs::1:", ["s3:ObjectCreated:Put"])),
      )
      await put("invalid event", notification(queue(arn, ["s3:ObjectCreated:Nope"])))
      await put(
        "event before arn invalid",
        notification(
          `<QueueConfiguration><Event>s3:Bad</Event><Queue>bad</Queue></QueueConfiguration>`,
        ),
      )
      await put("no events", notification(queue(arn, [])))
      await put(
        "duplicate events",
        notification(queue(arn, ["s3:ObjectCreated:Put", "s3:ObjectCreated:Put"])),
      )
      await put(
        "filter bad name",
        notification(
          queue(
            arn,
            ["s3:ObjectCreated:Put"],
            "<Filter><S3Key><FilterRule><Name>middle</Name><Value>x</Value></FilterRule></S3Key></Filter>",
          ),
        ),
      )
      await put(
        "filter two prefixes",
        notification(
          queue(
            arn,
            ["s3:ObjectCreated:Put"],
            "<Filter><S3Key><FilterRule><Name>prefix</Name><Value>a</Value></FilterRule><FilterRule><Name>prefix</Name><Value>b</Value></FilterRule></S3Key></Filter>",
          ),
        ),
      )
      await put(
        "filter two suffixes",
        notification(
          queue(
            arn,
            ["s3:ObjectCreated:Put"],
            "<Filter><S3Key><FilterRule><Name>suffix</Name><Value>a</Value></FilterRule><FilterRule><Name>suffix</Name><Value>b</Value></FilterRule></S3Key></Filter>",
          ),
        ),
      )
      await put(
        "topic",
        notification(
          "<TopicConfiguration><Topic>arn:aws:sns:us-east-1:1:t</Topic><Event>s3:ObjectCreated:Put</Event></TopicConfiguration>",
        ),
      )
      await put(
        "cloud function",
        notification(
          "<CloudFunctionConfiguration><CloudFunction>arn:aws:lambda:us-east-1:1:f</CloudFunction><Event>s3:ObjectCreated:Put</Event></CloudFunctionConfiguration>",
        ),
      )
      await put(
        "duplicate queues",
        notification(queue(arn, ["s3:ObjectCreated:Put"]) + queue(arn, ["s3:ObjectCreated:Put"])),
      )
      await put(
        "wrong root",
        `<Notification>${queue(arn, ["s3:ObjectCreated:Put"])}</Notification>`,
      )
      await put("truncated", "<NotificationConfiguration><QueueConfiguration>")
      await put("not xml", "nope")
      await put("unknown child ignored", notification("<Bogus>1</Bogus>"))
      await put(
        "filter value with dot segments accepted by decoder",
        notification(
          queue(
            arn,
            ["s3:ObjectCreated:Put"],
            "<Filter><S3Key><FilterRule><Name>prefix</Name><Value>a/../b</Value></FilterRule></S3Key></Filter>",
          ),
        ),
      )
      await s.req("get still default", {
        method: "GET",
        path: keyPath(b),
        query: { notification: "" },
      })
    },
  },

  // ── replication ──────────────────────────────────────────────────────────
  {
    name: "replication-unversioned-bucket",
    async run(s) {
      const b = await s.bucket("repl")
      const missing = s.name("replmissing")
      const body = replicationConfig(replicationRule())
      await s.req("get none", { method: "GET", path: keyPath(b), query: { replication: "" } })
      await s.req("put needs versioning", {
        method: "PUT",
        path: keyPath(b),
        query: { replication: "" },
        body,
      })
      await s.req("put garbage needs versioning first", {
        method: "PUT",
        path: keyPath(b),
        query: { replication: "" },
        body: "garbage",
      })
      await s.req("delete none", { method: "DELETE", path: keyPath(b), query: { replication: "" } })
      await s.req("metrics", {
        method: "GET",
        path: keyPath(b),
        query: { "replication-metrics": "" },
      })
      await s.req("metrics v2", {
        method: "GET",
        path: keyPath(b),
        query: { "replication-metrics": "2" },
      })
      await s.req("metrics v1 explicit", {
        method: "GET",
        path: keyPath(b),
        query: { "replication-metrics": "1" },
      })
      await s.req("reset start", {
        method: "PUT",
        path: keyPath(b),
        query: { "replication-reset": "" },
      })
      await s.req("reset start bad duration", {
        method: "PUT",
        path: keyPath(b),
        query: { "replication-reset": "", "older-than": "forever" },
      })
      await s.req("reset start with arn", {
        method: "PUT",
        path: keyPath(b),
        query: {
          "replication-reset": "",
          arn: "arn:minio:replication::id:target",
          "older-than": "24h",
        },
      })
      await s.req("reset status", {
        method: "GET",
        path: keyPath(b),
        query: { "replication-reset-status": "" },
      })
      await s.req("check", { method: "GET", path: keyPath(b), query: { "replication-check": "" } })
      for (const [step, query] of [
        ["get", { replication: "" }],
        ["metrics", { "replication-metrics": "" }],
        ["metrics v2", { "replication-metrics": "2" }],
        ["reset status", { "replication-reset-status": "" }],
        ["check", { "replication-check": "" }],
      ] as const)
        await s.req(`${step} missing bucket`, { method: "GET", path: keyPath(missing), query })
      await s.req("put missing bucket", {
        method: "PUT",
        path: keyPath(missing),
        query: { replication: "" },
        body,
      })
      await s.req("delete missing bucket", {
        method: "DELETE",
        path: keyPath(missing),
        query: { replication: "" },
      })
      await s.req("reset start missing bucket", {
        method: "PUT",
        path: keyPath(missing),
        query: { "replication-reset": "" },
      })
      await s.req("reset start bad duration missing bucket", {
        method: "PUT",
        path: keyPath(missing),
        query: { "replication-reset": "", "older-than": "x" },
      })
    },
  },
  {
    name: "replication-versioned-bucket",
    async run(s) {
      const b = await s.bucket("replv", { versioning: "Enabled" })
      const put = (step: string, body: string) =>
        s.req(step, { method: "PUT", path: keyPath(b), query: { replication: "" }, body })
      await put("no remote target", replicationConfig(replicationRule()))
      await put(
        "minio target arn",
        replicationConfig(
          replicationRule().replace(
            "arn:aws:s3:::target",
            "arn:minio:replication:us-east-1:abc:target",
          ),
        ),
      )
      await put("garbage", "garbage")
      await put("empty body", "")
      await put("wrong root", "<Replication></Replication>")
      await put("no rules", replicationConfig(""))
      await put(
        "rule without destination",
        replicationConfig("<Rule><ID>x</ID><Status>Enabled</Status></Rule>"),
      )
      await put(
        "role arn",
        replicationConfig(replicationRule(), "<Role>arn:minio:replication::id:target</Role>"),
      )
      await put("invalid role arn", replicationConfig(replicationRule(), "<Role>nope</Role>"))
      await put(
        "arn of another type",
        replicationConfig(
          replicationRule().replace("arn:aws:s3:::target", "arn:minio:sqs::id:target"),
        ),
      )
      await put(
        "arn of another type as role",
        replicationConfig("", "<Role>arn:minio:sqs::id:target</Role>"),
      )
      await put(
        "destination not an arn",
        replicationConfig(replicationRule().replace("arn:aws:s3:::target", "target")),
      )
      await put(
        "destination bad storage class",
        replicationConfig(
          replicationRule().replace("</Bucket>", "</Bucket><StorageClass>GLACIER</StorageClass>"),
        ),
      )
      await put(
        "priority not a number",
        replicationConfig(
          replicationRule().replace("<Priority>1</Priority>", "<Priority>one</Priority>"),
        ),
      )
      await put("truncated", "<ReplicationConfiguration><Rule>")
      await put(
        "bad status",
        replicationConfig(
          replicationRule().replace("<Status>Enabled</Status>", "<Status>On</Status>"),
        ),
      )
      await s.req("get none", { method: "GET", path: keyPath(b), query: { replication: "" } })
      await s.req("check", { method: "GET", path: keyPath(b), query: { "replication-check": "" } })
      await s.req("metrics", {
        method: "GET",
        path: keyPath(b),
        query: { "replication-metrics": "" },
      })
      await s.req("reset status", {
        method: "GET",
        path: keyPath(b),
        query: { "replication-reset-status": "" },
      })
      await s.req("delete none", { method: "DELETE", path: keyPath(b), query: { replication: "" } })
    },
  },
]
