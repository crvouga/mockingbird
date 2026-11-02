import { expect, test } from "bun:test"
import { HonoRequest } from "./src/vendor/core/http.js"

const parse = (contentType: string, body: BodyInit) =>
  new HonoRequest(
    new Request("http://vendor.local/", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    }),
    {},
  ).parseBody()

// RFC 9110 §8.3.1: type and subtype names are case-insensitive.
test.each([
  ["Application/JSON", '{"name":"n"}'],
  ["APPLICATION/JSON; charset=UTF-8", '{"name":"n"}'],
  ["Application/X-WWW-Form-Urlencoded", "name=n"],
])("parseBody reads %s", async (contentType, body) => {
  expect(await parse(contentType, body)).toEqual({ name: "n" })
})

test("parseBody reads Multipart/Form-Data and keeps the boundary's case", async () => {
  const boundary = "AbCdEf123"
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nn\r\n--${boundary}--\r\n`
  expect(await parse(`Multipart/Form-Data; boundary=${boundary}`, body)).toEqual({ name: "n" })
})
