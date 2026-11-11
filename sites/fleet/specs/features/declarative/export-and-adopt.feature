@declarative
Feature: Exporting an organization as a mockingbird.yaml, and adopting it
  Nobody has to write their first file from nothing. Any organization can be exported as the
  mockingbird.yaml that reproduces it; applying that file changes nothing and puts the
  organization under the file's control. A managed organization exports the file it was given.

  Rule: An organization configured by hand exports as a file that reproduces it

    Background:
      Given Ada has configured the organization "globex" by hand:
        | project | fleet          | access | requests per minute | emulator | target | durability |
        | api     | globex-preview | open   | 120                 | resend   | resend | strict     |
        | api     | globex-preview | open   | 120                 | mail     | resend |            |
        | api     | globex-live    | key    |                     | stripe   | stripe | ephemeral  |
        | docs    |                |        |                     |          |        |            |

    Scenario: The export declares every project, fleet and emulator, with its settings
      When Ada exports the organization "globex" as a mockingbird.yaml
      Then the request succeeds
      And the export says the organization is configured by hand
      And the exported file is:
        """
        version: 1
        organization: <globex>
        name: Globex
        projects:
          api:
            name: Api
            fleets:
              <globex-preview>:
                name: Globex-preview
                access: open
                requestsPerMinute: 120
                services:
                  resend: { durability: strict }
                  mail: { target: resend, durability: buffered }
              <globex-live>:
                name: Globex-live
                access: key
                services:
                  stripe: { durability: ephemeral }
          docs:
            name: Docs
            fleets: {}
        """

    Scenario: Exporting changes nothing
      When Ada exports the organization "globex" as a mockingbird.yaml
      Then the organization "globex" is configured by hand

    Scenario: Planning the exported file finds nothing to change
      Given Ada exports the organization "globex" as a mockingbird.yaml
      And she saves the exported file as her mockingbird.yaml
      When she plans it
      Then nothing is reported to change
      And the organization "globex" is configured by hand

    Scenario: Applying the exported file changes nothing and makes the organization managed
      Given an SDK has sent an email through the "resend" emulator of "globex-preview"
      And Ada exports the organization "globex" as a mockingbird.yaml
      When she applies the exported file
      Then nothing is reported to change
      And the organization "globex" is managed by the file Ada applied
      And the email can be read back from the "resend" emulator of "globex-preview"

    Scenario: Once adopted, the organization is changed through the file
      Given Ada exports the organization "globex" as a mockingbird.yaml
      And she saves the exported file as her mockingbird.yaml
      And she has applied it
      When she changes "requestsPerMinute: 120" to "requestsPerMinute: 60" in the file
      And she applies it
      Then the only change reported is:
        | update | fleet | globex-preview | requestsPerMinute 120 → 60 |
      And the fleet "globex-preview" is configured as:
        | requests per minute | 60 |

    Scenario: A viewer can export the organization
      Given Bo has joined "globex" with the viewer role
      When Bo exports the organization "globex" as a mockingbird.yaml
      Then the request succeeds

    Scenario: Someone outside the organization cannot export it
      When Eve exports the organization "globex" as a mockingbird.yaml
      Then the request is refused as "not_found"

  Rule: A managed organization exports the file that was applied

    Background:
      Given Ada has applied this mockingbird.yaml:
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
                  stripe: { durability: strict, port: 4010 }
                  resend: {}
                  db: { target: postgres, protocol: postgres, port: 5432, local: true }
        """

    Scenario: The export is the applied file, local-only services and local keys included
      When Ada exports the organization "acme" as a mockingbird.yaml
      Then the export says the organization is managed by the file Ada applied
      And the exported file is the file that was applied
      And the exported file declares the local-only service "db" of "acme-staging"

    Scenario: The local-only service is in the file but not in Fleet Cloud
      Then the fleet "acme-staging" runs stripe and resend
      And Fleet Cloud serves nothing as "db" in the fleet "acme-staging"

    Scenario: Applying the export of a managed organization changes nothing
      Given Ada exports the organization "acme" as a mockingbird.yaml
      When she applies the exported file
      Then nothing is reported to change

    Scenario: After a release, the export describes what Fleet Cloud runs
      Given Ada has released the organization "acme" from its file
      When Ada exports the organization "acme" as a mockingbird.yaml
      Then the export says the organization is configured by hand
      And the exported file is:
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
                  stripe: { durability: strict }
                  resend: { durability: buffered }
        """
