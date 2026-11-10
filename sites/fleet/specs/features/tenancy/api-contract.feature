@tenancy @contract
Feature: API contract and integration surface
  Another application integrates through HTTP alone. This feature pins down the parts of that
  surface every client depends on: the published contract, the public endpoints, the shape of
  errors, request ids, cross-origin access and the guide written for agents.

  Rule: The contract is published as OpenAPI

    Scenario: The OpenAPI document needs no credentials
      When an API client sends "GET /api/openapi.json"
      Then the response status is 200
      And the document declares OpenAPI "3.1.0"
      And the document's server is this server's "/api/v1"

    Scenario: The served contract is the committed "openapi.json"
      When an API client sends "GET /api/openapi.json"
      Then the document matches the committed contract, apart from the server address

    Scenario: Every operation in the contract has its own id
      When an API client sends "GET /api/openapi.json"
      Then no two operations in the document share an id

    Scenario: Every operation in the contract is served
      When an API client sends "GET /api/openapi.json"
      Then every operation in the document is routed by the server

    Scenario: The contract lists every operation the server has
      When an API client sends "GET /api/openapi.json"
      Then the document lists exactly the operations the agent guide lists

    Scenario Outline: The contract documents "<operation>"
      When an API client sends "GET /api/openapi.json"
      Then the document has the operation "<operation>"

      Examples:
        | operation                                  |
        | GET /me                                    |
        | POST /tokens                               |
        | POST /orgs                                 |
        | DELETE /orgs/{orgId}                       |
        | PATCH /orgs/{orgId}/members/{userId}       |
        | POST /orgs/{orgId}/invites                 |
        | POST /invites/accept                       |
        | POST /orgs/{orgId}/api-keys                |
        | GET /orgs/{orgId}/audit                    |
        | POST /orgs/{orgId}/projects                |
        | POST /projects/{projectId}/fleets          |
        | PATCH /fleets/{fleetId}                    |
        | PUT /fleets/{fleetId}/emulators/{name}     |
        | PATCH /fleets/{fleetId}/emulators/{name}   |
        | DELETE /fleets/{fleetId}/emulators/{name}  |

  Rule: What a client needs before signing in is public

    Scenario: The configuration endpoint is public
      When an API client sends "GET /api/v1/config"
      Then the response status is 200
      And the configuration names this server's address, its sign-in methods and the durability modes

    Scenario: The emulator catalog is public
      When an API client sends "GET /api/v1/catalog"
      Then the response status is 200
      And the catalog offers "stripe"
      And the catalog offers "resend"
      And every catalog entry has a target, a package, a display name, a category and a description

    Scenario Outline: The catalog does not offer the wire-protocol emulator "<target>"
      When an API client sends "GET /api/v1/catalog"
      Then the catalog does not offer "<target>"

      Examples:
        | target   |
        | postgres |
        | redis    |
        | sqlite   |

  Rule: Every error has the same envelope

    Scenario Outline: "<request>" is answered <status> "<code>"
      When an API client sends "<request>"
      Then the response status is <status>
      And the request is refused as "<code>"
      And the API reply is an error envelope with a code and a message

      Examples:
        | request                    | status | code               |
        | GET /api/v1/me             | 401    | unauthorized       |
        | GET /api/v1/orgs           | 401    | unauthorized       |
        | GET /api/v1/no-such-thing  | 404    | not_found          |
        | GET /api/v2/me             | 404    | not_found          |
        | GET /api/                  | 404    | not_found          |
        | PUT /api/v1/me             | 405    | method_not_allowed |
        | DELETE /api/v1/config      | 405    | method_not_allowed |
        | POST /api/v1/catalog       | 405    | method_not_allowed |
        | DELETE /api/v1/orgs        | 405    | method_not_allowed |

    Scenario: An invalid body is answered with every problem in "details"
      Given Ada is signed in
      When Ada sends an organization with a malformed slug and an unrecognised field
      Then the response status is 400
      And the request is refused as "invalid_request"
      And the API reply is an error envelope with a code and a message
      And the error details are a list of 2 problems, the first of which is the message

    Scenario Outline: A body that is <what> is refused
      Given Ada is signed in
      When Ada sends a body that is <what> to create an organization
      Then the response status is <status>
      And the request is refused as "<code>"
      And the message says "<message>"

      Examples:
        | what              | status | code            | message                                |
        | not JSON          | 400    | invalid_request | The request body is not valid JSON     |
        | a JSON list       | 400    | invalid_request | The request body must be a JSON object |
        | larger than 1 MiB | 413    | body_too_large  | Body too large                         |

  Rule: Every reply carries a request id

    Scenario Outline: The reply to "<request>" carries a generated request id
      When an API client sends "<request>"
      Then the API reply carries a generated request id

      Examples:
        | request                   |
        | GET /api/v1/config        |
        | GET /api/v1/me            |
        | GET /api/v1/no-such-thing |
        | GET /api/openapi.json     |
        | GET /llms.txt             |

    Scenario: A client's own request id is echoed back
      When an API client sends "GET /api/v1/me" with the request id "trace-me-12345"
      Then the API reply carries the request id "trace-me-12345"

    Scenario Outline: An unusable request id "<supplied>" is replaced
      When an API client sends "GET /api/v1/me" with the request id "<supplied>"
      Then the API reply carries a generated request id

      Examples:
        | supplied         |
        | short            |
        | has spaces in it |
        | <script>alert(1) |

  Rule: Browser apps on allowed origins may call the API with a key, never with cookies

    Scenario: A preflight from an allowed origin is answered
      Given the server is configured with:
        | CORS_ORIGINS | https://app.example.com,https://other.example.com |
      When a browser on "https://app.example.com" asks permission to call the API
      Then the response status is 204
      And the API allows the origin "https://app.example.com"
      And the API allows the headers "authorization, content-type, x-mockingbird-api-key"
      And the API does not allow cookies from other origins

    Scenario: Every allowed origin is answered with its own origin
      Given the server is configured with:
        | CORS_ORIGINS | https://app.example.com,https://other.example.com |
      When a browser on "https://other.example.com" asks permission to call the API
      Then the API allows the origin "https://other.example.com"

    Scenario: A reply to an allowed origin can be read by its page
      Given the server is configured with:
        | CORS_ORIGINS | https://app.example.com |
      When a browser on "https://app.example.com" sends "GET /api/v1/config"
      Then the response status is 200
      And the API allows the origin "https://app.example.com"
      And the page may read the request id and rate-limit headers

    Scenario: An error reply to an allowed origin can be read too
      Given the server is configured with:
        | CORS_ORIGINS | https://app.example.com |
      When a browser on "https://app.example.com" sends "GET /api/v1/me"
      Then the response status is 401
      And the API allows the origin "https://app.example.com"

    Scenario: An origin that is not allowed gets no permission
      Given the server is configured with:
        | CORS_ORIGINS | https://app.example.com |
      When a browser on "https://evil.example" asks permission to call the API
      Then the API allows no origin

    Scenario: A reply to an origin that is not allowed carries no permission
      Given the server is configured with:
        | CORS_ORIGINS | https://app.example.com |
      When a browser on "https://evil.example" sends "GET /api/v1/config"
      Then the API allows no origin

    Scenario: No origin is allowed unless the server lists it
      When a browser on "https://app.example.com" asks permission to call the API
      Then the API allows no origin

  Rule: The agent guide says how to integrate with this server

    Scenario: The guide is plain text, public, and names this server
      When an API client sends "GET /llms.txt"
      Then the response status is 200
      And the guide is plain text
      And the guide gives this server's API base and OpenAPI address

    Scenario Outline: The guide covers <topic>
      When an API client sends "GET /llms.txt"
      Then the guide mentions "<text>"

      Examples:
        | topic                    | text                              |
        | how to authenticate      | Authorization: Bearer             |
        | personal tokens          | mbf_u_                            |
        | organization keys        | mbf_o_                            |
        | creating a fleet         | POST /projects/{projectId}/fleets |
        | durability               | strict                            |
        | calling emulators        | x-mockingbird-api-key             |
        | the error envelope       | Every error is                    |
        | quotas                   | quota_exceeded                    |
        | rate limits              | Retry-After                       |
        | request ids              | x-request-id                      |
        | hidden resources         | 404 not_found                     |
        | slug conflicts           | 409 conflict                      |
