@fleets @isolation
Feature: Emulators cannot act as the dashboard
  Emulators serve whatever a vendor would, including web pages. Such a page must never run with
  the dashboard's authority. On one shared origin every emulator response is sandboxed; with a
  second hostname for fleets, each host serves only its own half.

  Rule: On a shared origin, emulator responses are sandboxed

    Background:
      Given Ada has an open fleet "Staging" with a buffered Resend emulator

    Scenario: An emulator's response is confined to a sandbox
      When an SDK sends an email through "Staging"
      Then the response is sandboxed away from the dashboard
      And the response forbids guessing its content type

    Scenario: An emulator's own error responses are sandboxed as well
      When an SDK sends an email through "Staging" without the vendor's API key
      Then the response is sandboxed away from the dashboard

    Scenario: The dashboard's own pages are not sandboxed
      When a browser opens the dashboard
      Then the response status is 200
      And the response is a dashboard page that may not be framed

  Rule: With a separate fleet host, each host serves only its half

    Background:
      Given the server is configured with:
        | FLEET_URL | https://fleets.example.test |
      And Ada has an open fleet "Staging" with a buffered Resend emulator

    Scenario: Fleet and emulator URLs are on the fleet host
      Then the URL of "Staging" is on "https://fleets.example.test"
      And the URL of its emulator is on "https://fleets.example.test"

    Scenario: The fleet host serves fleets
      When the fleet "Staging" is opened on the fleet host
      Then the response status is 200
      And the discovery document lists these emulators:
        | name   | target | durability |
        | resend | resend | buffered   |

    Scenario: Emulator responses on the fleet host need no sandbox
      When an SDK sends an email through "Staging" on the fleet host
      Then the response status is 200
      And the response is not sandboxed

    Scenario Outline: The fleet host does not serve <what>
      When "<path>" is requested on the fleet host
      Then the response status is 404

      Examples:
        | what            | path           |
        | the dashboard   | /              |
        | the control API | /api/v1/config |
        | the API guide   | /llms.txt      |

    Scenario: The dashboard host does not serve fleets
      When the fleet "Staging" is opened on the dashboard host
      Then the response status is 404

    Scenario: The dashboard host still serves the dashboard and the control API
      When "/api/v1/config" is requested on the dashboard host
      Then the response status is 200

    Scenario Outline: Both hosts answer health checks
      When "/health" is requested on the <host> host
      Then the response status is 200

      Examples:
        | host      |
        | fleet     |
        | dashboard |
