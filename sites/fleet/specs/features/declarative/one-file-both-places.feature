@declarative
Feature: One mockingbird.yaml, in Fleet Cloud and on your machine
  The file that Fleet Cloud applies is the file `mockingbird-fleet serve` runs. A fleet's
  services are declared once: Fleet Cloud hosts them at the fleet's URL, and the CLI starts the
  same services locally, so code that works against one works against the other. Each side
  ignores the keys that are the other's.

  Rule: The same file runs the same fleet in both places

    Background:
      Given Ada's repository holds this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        name: Acme
        projects:
          web:
            name: Web app
            fleets:
              <acme-staging>:
                name: Staging
                access: open
                requestsPerMinute: 600
                services:
                  stripe: { durability: strict, port: 0 }
                  resend: { port: 0, flushIntervalMs: 500 }
                  billing: { target: stripe, seed: "42", port: 0 }
                  db: { target: postgres, protocol: postgres, port: 0, local: true }
        """

    Scenario: A vendor SDK's call succeeds against Fleet Cloud and against the local fleet
      When she applies it
      And she runs "mockingbird-fleet serve --config mockingbird.yaml"
      Then the same Resend SDK call succeeds against "resend" of "acme-staging" in Fleet Cloud and against "resend" on her machine
      And the same Stripe SDK call succeeds against "stripe" of "acme-staging" in Fleet Cloud and against "stripe" on her machine
      And the same Stripe SDK call succeeds against "billing" of "acme-staging" in Fleet Cloud and against "billing" on her machine

    Scenario: Both places run the services the file declares, under the names it gives them
      When she applies it
      And she runs "mockingbird-fleet serve --config mockingbird.yaml"
      Then the fleet "acme-staging" runs stripe, resend and billing
      And her machine runs stripe, resend, billing and db

    Scenario: A service marked local runs on her machine and is absent from Fleet Cloud
      When she applies it
      And she runs "mockingbird-fleet serve --config mockingbird.yaml"
      Then "db" on her machine is a PostgreSQL server that answers queries
      And Fleet Cloud serves nothing as "db" in the fleet "acme-staging"

    Scenario: The local fleet needs neither Fleet Cloud nor a credential
      When she runs "mockingbird-fleet serve --config mockingbird.yaml"
      Then her machine runs stripe, resend, billing and db
      And the Resend SDK's call succeeds against "resend" on her machine
      And Ada belongs to no organizations

  Rule: Each side ignores the keys that are the other's

    Scenario: Keys only Fleet Cloud reads do not stop the local fleet
      Given Ada's repository holds this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        name: Acme
        projects:
          web:
            name: Web app
            fleets:
              <acme-staging>:
                name: Staging
                access: key
                requestsPerMinute: 5
                services:
                  resend:
                    port: 0
                    durability: ephemeral
                    flushIntervalMs: 250
                    webhookOrigins: ["https://hooks.example.test"]
        """
      When she runs "mockingbird-fleet serve --config mockingbird.yaml"
      Then her machine runs resend
      And the Resend SDK's call succeeds against "resend" on her machine

    Scenario: A port chosen for the local fleet is used locally and ignored by Fleet Cloud
      Given Ada's repository holds this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        projects:
          web:
            fleets:
              <acme-staging>:
                services:
                  resend: { port: <a-free-port> }
        """
      When she applies it
      And she runs "mockingbird-fleet serve --config mockingbird.yaml"
      Then "resend" on her machine listens on the port the file chose
      And the same Resend SDK call succeeds against "resend" of "acme-staging" in Fleet Cloud and against "resend" on her machine

  Rule: A file that declares several fleets runs the one that is chosen

    Background:
      Given Ada's repository holds this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        projects:
          web:
            fleets:
              <acme-staging>:
                services:
                  resend: { port: 0 }
              <acme-preview>:
                services:
                  stripe: { port: 0 }
          api:
            fleets:
              <acme-api>:
                services:
                  billing: { target: stripe, port: 0 }
                  mail: { target: resend, port: 0 }
        """

    Scenario Outline: --fleet <fleet> runs that fleet's services
      When she runs "mockingbird-fleet serve --config mockingbird.yaml --fleet <<fleet>>"
      Then her machine runs <services>

      Examples:
        | fleet        | services         |
        | acme-staging | resend           |
        | acme-preview | stripe           |
        | acme-api     | billing and mail |

    Scenario: Without a choice, the fleet does not start and the choices are listed
      When she runs "mockingbird-fleet serve --config mockingbird.yaml"
      Then no local fleet starts
      And it fails, saying:
        """
        mockingbird-fleet: mockingbird.yaml declares several fleets; choose one with --fleet: acme-staging, acme-preview, acme-api
        """

    Scenario: Choosing a fleet the file does not declare fails with the ones it does
      When she runs "mockingbird-fleet serve --config mockingbird.yaml --fleet acme-production"
      Then no local fleet starts
      And it fails, saying:
        """
        mockingbird-fleet: mockingbird.yaml declares no fleet "acme-production"; it declares: acme-staging, acme-preview, acme-api
        """

  Rule: A file that declares one fleet needs no choice

    Scenario: The only fleet runs without --fleet, and can also be named
      Given Ada's repository holds this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        projects:
          web:
            fleets:
              <acme-staging>:
                services:
                  resend: { port: 0 }
        """
      When she runs "mockingbird-fleet serve --config mockingbird.yaml --fleet <acme-staging>"
      Then her machine runs resend

    Scenario: A file that declares no fleets has nothing to run
      Given Ada's repository holds this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        projects:
          web: {}
        """
      When she runs "mockingbird-fleet serve --config mockingbird.yaml"
      Then no local fleet starts
      And it fails, saying:
        """
        mockingbird-fleet: mockingbird.yaml declares no fleets
        """

  Rule: A plain local fleet configuration still works

    Scenario: A fleet configuration in YAML
      Given Ada's repository holds this fleet configuration "fleet.yaml":
        """
        schemaVersion: 1
        services:
          resend: { port: 0 }
          billing: { target: stripe, port: 0 }
        """
      When she runs "mockingbird-fleet serve --config fleet.yaml"
      Then her machine runs resend and billing
      And the Resend SDK's call succeeds against "resend" on her machine
      And the Stripe SDK's call succeeds against "billing" on her machine

    Scenario: A fleet configuration in JSON
      Given Ada's repository holds this fleet configuration "mockingbird.json":
        """
        {
          "schemaVersion": 1,
          "services": {
            "resend": { "port": 0 },
            "billing": { "target": "stripe", "port": 0 }
          }
        }
        """
      When she runs "mockingbird-fleet serve --config mockingbird.json"
      Then her machine runs resend and billing
      And the Resend SDK's call succeeds against "resend" on her machine
      And the Stripe SDK's call succeeds against "billing" on her machine

    Scenario: --fleet means nothing for a plain fleet configuration
      Given Ada's repository holds this fleet configuration "fleet.yaml":
        """
        schemaVersion: 1
        services:
          resend: { port: 0 }
        """
      When she runs "mockingbird-fleet serve --config fleet.yaml --fleet staging"
      Then no local fleet starts
      And it fails, saying:
        """
        mockingbird-fleet: --fleet applies to a mockingbird.yaml declaration
        """

  Rule: An invalid file fails before anything listens

    Scenario: Every mistake is reported with its path, and no fleet starts
      Given Ada's repository holds this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        projects:
          web:
            fleets:
              <acme-staging>:
                acess: open
                services:
                  resend: { port: <a-free-port>, durability: eventual }
        """
      When she runs "mockingbird-fleet serve --config mockingbird.yaml"
      Then no local fleet starts
      And it fails, saying:
        """
        mockingbird-fleet: mockingbird.yaml is invalid:
          projects.web.fleets.acme-staging.acess: unknown key; expected one of name, access, requestsPerMinute, services
          projects.web.fleets.acme-staging.services.resend.durability: must be one of strict, buffered, ephemeral
        """
      And its error output is a message, not a stack trace
      And nothing listens on the port the file chose

    Scenario: A file that is missing is reported by name
      When Ada runs "mockingbird-fleet serve --config nowhere.yaml"
      Then no local fleet starts
      And its error output is a message, not a stack trace
