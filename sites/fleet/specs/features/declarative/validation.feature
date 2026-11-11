@declarative
Feature: A mockingbird.yaml is validated before anything changes
  A mistake in the file is reported with the path of its key, every mistake at once, and
  nothing is created or changed. The organization's quotas apply to what the file declares, and
  a fleet's slug, being its URL, can belong to only one organization.

  Rule: An invalid file is refused with the path of each problem

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
                access: open
                requestsPerMinute: 600
                services:
                  stripe: { durability: strict }
                  mail: { target: resend, seed: "42" }
        """

    Scenario Outline: <mistake> is refused, pointing at <path>
      When she changes "<from>" to "<to>" in the file
      And she applies it
      Then the file is refused as invalid at "<path>", saying "<problem>"
      And Ada belongs to no organizations

      Examples: the shape of the file
        | mistake                    | from                   | to                     | path                                         | problem                                                    |
        | A version from the future  | version: 1             | version: 2             | version                                      | must be 1                                                  |
        | A missing organization     | organization: <acme>   | # no organization      | organization                                 | must be the organization's slug                            |
        | An organization name       | organization: <acme>   | organization: Acme Inc | organization                                 | must be 1 to 40 lowercase letters, digits and hyphens      |
        | A project slug in capitals | web:                   | Web:                   | projects.Web                                 | must be 1 to 40 lowercase letters, digits and hyphens      |
        | A fleet slug with a space  | <acme-staging>:        | acme staging:          | projects.web.fleets.acme staging             | must be 1 to 40 lowercase letters, digits and hyphens      |
        | An empty name              | name: Web app          | name: ""               | projects.web.name                            | must be 1 to 80 characters                                 |
        | A misspelt top-level key   | name: Acme             | title: Acme            | title                                        | unknown key; expected one of version, organization, name, projects |
        | A misspelt project key     | fleets:                | fleet:                 | projects.web.fleet                           | unknown key; expected one of name, fleets                  |
        | A misspelt fleet key       | access: open           | acess: open            | projects.web.fleets.acme-staging.acess       | unknown key; expected one of name, access, requestsPerMinute, services |

      Examples: what Fleet Cloud adds to a fleet
        | mistake                    | from                   | to                     | path                                                    | problem                                    |
        | An unknown access          | access: open           | access: public         | projects.web.fleets.acme-staging.access                 | must be one of open, key                   |
        | A request rate of zero     | requestsPerMinute: 600 | requestsPerMinute: 0   | projects.web.fleets.acme-staging.requestsPerMinute      | must be a whole number of at least 1       |
        | An unknown durability      | durability: strict     | durability: eventual   | projects.web.fleets.acme-staging.services.stripe.durability | must be one of strict, buffered, ephemeral |
        | A flush interval too short | durability: strict     | flushIntervalMs: 5     | projects.web.fleets.acme-staging.services.stripe.flushIntervalMs | must be a whole number from 100 to 60000 |
        | A numeric seed             | seed: "42"             | seed: 42               | projects.web.fleets.acme-staging.services.mail.seed     | must be a string (quote numbers: seed: "42") |
        | A service that is a list   | mail: { target: resend, seed: "42" } | mail: [resend] | projects.web.fleets.acme-staging.services.mail    | must be a mapping (or empty for every default) |
        | A service name in capitals | mail: {                | Mail: {                | projects.web.fleets.acme-staging.services.Mail          | must be 1 to 40 lowercase letters, digits and hyphens |

      Examples: emulators Fleet Cloud cannot run
        | mistake                              | from                                 | to                                           | path                                           | problem                                           |
        | An emulator that does not exist      | mail: { target: resend, seed: "42" } | mail: { target: sendgrid }                   | projects.web.fleets.acme-staging.services.mail | mark a service that should run only in a local fleet with `local: true` |
        | A PostgreSQL server not marked local | mail: { target: resend, seed: "42" } | db: { target: postgres, protocol: postgres } | projects.web.fleets.acme-staging.services.db   | Fleet Cloud runs HTTP emulators only              |
        | A Redis server not marked local      | mail: { target: resend, seed: "42" } | cache: { target: redis, protocol: redis }    | projects.web.fleets.acme-staging.services.cache | mark a service that should run only in a local fleet with `local: true` |
        | A setting the emulator does not have | mail: { target: resend, seed: "42" } | surveys: { target: formbricks, settings: { colour: blue } } | projects.web.fleets.acme-staging.services.surveys | colour                                 |
        | Settings for an emulator with none   | stripe: { durability: strict }       | stripe: { settings: { colour: blue } }       | projects.web.fleets.acme-staging.services.stripe | takes no settings                               |

    Scenario: Every problem in the file is reported at once
      When she changes the file to:
        """
        version: 2
        organization: Acme Inc
        projects:
          web:
            colour: blue
            fleets:
              <acme-staging>:
                access: public
                services:
                  stripe: { durability: eventual }
              <acme-preview>:
                requestsPerMinute: many
                services:
                  mail: { target: resend, seed: 42, local: sometimes }
        """
      And she applies it
      Then the file is refused as invalid, naming every problem:
        | version                                                      | must be 1                                                                      |
        | organization                                                 | organization "Acme Inc" must be 1 to 40 lowercase letters, digits and hyphens |
        | projects.web.colour                                          | unknown key; expected one of name, fleets                                      |
        | projects.web.fleets.acme-staging.access                      | must be one of open, key                                                       |
        | projects.web.fleets.acme-staging.services.stripe.durability | must be one of strict, buffered, ephemeral                                     |
        | projects.web.fleets.acme-preview.requestsPerMinute           | must be a whole number of at least 1                                           |
        | projects.web.fleets.acme-preview.services.mail.local         | must be true or false                                                          |
        | projects.web.fleets.acme-preview.services.mail.seed          | must be a string (quote numbers: seed: "42")                                   |
      And Ada belongs to no organizations

    Scenario: A fleet slug declared in two projects is refused, naming both places
      When she adds under "projects:" in the file:
        """
        api:
          fleets:
            <acme-staging>:
              services:
                resend: {}
        """
      And she applies it
      Then the file is refused as invalid at "projects.web.fleets.acme-staging", saying "is also declared at projects.api.fleets.acme-staging"
      And Ada belongs to no organizations

    Scenario: A file that is not valid YAML is refused
      When she applies a file that is not valid YAML
      Then the request is refused as "invalid_request"
      And the message says "The request body is not valid YAML"
      And Ada belongs to no organizations

    Scenario: A file that is a list rather than a mapping is refused
      When she changes the file to:
        """
        - version: 1
        """
      And she applies it
      Then the request is refused as "invalid_request"
      And Ada belongs to no organizations

    Scenario: A plan validates the file exactly as an apply does
      When she changes "access: open" to "access: public" in the file
      And she plans it
      Then the file is refused as invalid at "projects.web.fleets.acme-staging.access", saying "must be one of open, key"

    Scenario: A service marked local may be anything, because Fleet Cloud does not run it
      When she adds under "services:" in the file:
        """
        db: { target: postgres, protocol: postgres, port: 5432, local: true }
        cache: { target: redis, protocol: redis, local: true }
        """
      And she applies it
      Then the file is reported as applied
      And the fleet "acme-staging" runs stripe and mail

  Rule: An invalid change to an existing organization changes nothing

    Scenario: A mistake in a later version of the file leaves the organization as it was
      Given Ada has applied this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        projects:
          web:
            fleets:
              <acme-staging>:
                services:
                  resend: { durability: strict }
        """
      When she changes the file to:
        """
        version: 1
        organization: <acme>
        name: Renamed
        projects:
          web:
            fleets:
              <acme-staging>:
                access: key
                services:
                  resend: { durability: strict }
                  mail: { target: sendgrid }
        """
      And she applies it
      Then the file is refused as invalid at "projects.web.fleets.acme-staging.services.mail", saying "sendgrid"
      And the fleet "acme-staging" runs resend
      And Fleet Cloud still matches the file that was applied

  Rule: Quotas apply to what the file declares

    Background:
      Given Ada has applied this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        projects:
          web:
            fleets:
              <acme-staging>:
                services:
                  resend: {}
        """

    Scenario: A file declaring more projects than the organization may have is refused
      Given the operator has set the "projectsPerOrg" quota of Ada's organization to 1
      When she adds under "projects:" in the file:
        """
        api: {}
        """
      And she applies it
      Then the request is refused as "quota_exceeded"
      And the refusal names the quota "projectsPerOrg"
      And the refusal says "mockingbird.yaml declares more projects than this organization may have (limit 1)"
      And Fleet Cloud still matches the file that was applied

    Scenario: A file declaring more fleets than the organization may have is refused
      Given the operator has set the "fleetsPerOrg" quota of Ada's organization to 1
      When she adds under "fleets:" in the file:
        """
        <acme-preview>:
          services:
            resend: {}
        """
      And she applies it
      Then the request is refused as "quota_exceeded"
      And the refusal names the quota "fleetsPerOrg"
      And nothing answers at the URL of the fleet "acme-preview"

    Scenario: A fleet declaring more emulators than a fleet may have is refused, naming the fleet
      Given the operator has set the "emulatorsPerFleet" quota of Ada's organization to 2
      When she adds under "services:" in the file:
        """
        mail: { target: resend }
        stripe: {}
        """
      And she applies it
      Then the request is refused as "quota_exceeded"
      And the refusal names the quota "emulatorsPerFleet"
      And the refusal says "projects.web.fleets.acme-staging declares more emulators than a fleet may have"
      And the fleet "acme-staging" runs resend

    Scenario: Local-only services do not count towards a fleet's emulators
      Given the operator has set the "emulatorsPerFleet" quota of Ada's organization to 1
      When she adds under "services:" in the file:
        """
        db: { target: postgres, protocol: postgres, local: true }
        """
      And she applies it
      Then the file is reported as applied

    Scenario: A file that fits exactly within the quotas is applied
      Given the operator has set the "fleetsPerOrg" quota of Ada's organization to 2
      When she adds under "fleets:" in the file:
        """
        <acme-preview>:
          services:
            resend: {}
        """
      And she applies it
      Then the file is reported as applied

    Scenario: A request rate above the organization's ceiling is refused
      Given the operator has set the "fleetRequestsPerMinute" quota of Ada's organization to 100
      When she adds under "<acme-staging>:" in the file:
        """
        requestsPerMinute: 500
        """
      And she applies it
      Then the request is refused as "invalid_request"
      And the refusal says "requestsPerMinute cannot exceed this organization's ceiling of 100"

    Scenario: A plan reports a quota that applying would exceed
      Given the operator has set the "projectsPerOrg" quota of Ada's organization to 1
      When she adds under "projects:" in the file:
        """
        api: {}
        """
      And she plans it
      Then the request is refused as "quota_exceeded"

  Rule: A fleet's slug belongs to one organization

    Background:
      Given Ada has applied this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        projects:
          web:
            fleets:
              <acme-staging>:
                services:
                  resend: { durability: strict }
        """

    Scenario: Declaring a fleet slug another organization uses is a conflict
      When Bo applies this mockingbird.yaml of his own:
        """
        version: 1
        organization: <bobs>
        projects:
          web:
            fleets:
              <acme-staging>:
                services:
                  stripe: {}
        """
      Then the request is refused as "conflict"
      And the refusal says "projects.web.fleets.acme-staging: the fleet slug "acme-staging" is already used by another organization"
      And Bo belongs to no organizations
      And the fleet "acme-staging" runs resend

    Scenario: A plan reports the conflict too
      Given Bo's repository holds this mockingbird.yaml:
        """
        version: 1
        organization: <bobs>
        projects:
          web:
            fleets:
              <acme-staging>:
                services:
                  stripe: {}
        """
      When he plans it
      Then the request is refused as "conflict"
