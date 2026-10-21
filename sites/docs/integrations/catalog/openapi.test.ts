import { expect, test } from "bun:test"
import { extractOperations } from "./openapi.ts"

test("playground overrides replace required headers regardless of contract casing", () => {
  const [operation] = extractOperations(
    {
      paths: {
        "/order": {
          post: {
            operationId: "CreateOrder",
            parameters: [
              {
                name: "X-Vendor-ID",
                in: "header",
                required: true,
                schema: { type: "integer" },
                example: 2,
              },
            ],
          },
        },
      },
    },
    ["CreateOrder"],
    { "x-vendor-id": "1" },
  )
  const request = new Request("http://mock.local/order", { headers: operation?.headers })
  expect(request.headers.get("x-vendor-id")).toBe("1")
})
