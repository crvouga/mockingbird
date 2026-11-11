@declarative
Feature: Planning and applying with the mockingbird-fleet CLI
  `mockingbird-fleet plan` and `mockingbird-fleet apply` send the repository's mockingbird.yaml
  to Fleet Cloud, with the address in MOCKINGBIRD_FLEET_URL and a personal token or an admin
  API key in MOCKINGBIRD_FLEET_TOKEN. They print one line per change, marked + for a creation,
  ~ for an update and - for a deletion, and exit non-zero when Fleet Cloud refuses.

  Rule: plan prints what would change and changes nothing

    Scenario: The plan for a new organization
      Given Ada's repository holds this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        projects:
          web:
            fleets:
              <acme-staging>:
                services:
                  stripe: { durability: strict }
                  mail: { target: resend }
        """
      When she runs "mockingbird-fleet plan"
      Then it exits with code 0
      And it prints:
        """
        + organization acme
        + project web
        + fleet acme-staging
        + emulator acme-staging/stripe  (strict)
        + emulator acme-staging/mail  (resend, buffered)
        mockingbird.yaml: 5 changes planned
        """
      And Ada belongs to no organizations

    Scenario: The plan for a change marks creations, updates and deletions
      Given Ada has applied this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        projects:
          web:
            fleets:
              <acme-staging>:
                access: open
                services:
                  resend: { durability: strict }
                  mail: { target: resend }
        """
      And she changes the file to:
        """
        version: 1
        organization: <acme>
        projects:
          web:
            fleets:
              <acme-staging>:
                access: key
                services:
                  resend: { durability: buffered }
                  stripe: {}
        """
      When she runs "mockingbird-fleet plan"
      Then it exits with code 0
      And it prints:
        """
        ~ fleet acme-staging  (access open → key)
        ~ emulator acme-staging/resend  (durability strict → buffered)
        + emulator acme-staging/stripe  (buffered)
        - emulator acme-staging/mail  (its stored state is erased)
        mockingbird.yaml: 4 changes planned
        """
      And the fleet "acme-staging" runs resend and mail
      And Fleet Cloud still matches the file that was applied

  Rule: apply makes Fleet Cloud match the file

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
                  resend: { durability: strict }
                  mail: { target: resend }
        """

    Scenario: The first apply creates the organization and its fleet
      When she runs "mockingbird-fleet apply"
      Then it exits with code 0
      And it prints:
        """
        + organization acme
        + project web
        + fleet acme-staging
        + emulator acme-staging/resend  (strict)
        + emulator acme-staging/mail  (resend, buffered)
        mockingbird.yaml: 5 changes applied
        """
      And the fleet "acme-staging" runs resend and mail
      And the organization "acme" is managed by the file Ada applied
      When an SDK sends an email through the "resend" emulator of "acme-staging"
      Then the email is accepted

    Scenario: Applying again reports nothing to change
      Given she runs "mockingbird-fleet apply"
      When she runs "mockingbird-fleet apply"
      Then it exits with code 0
      And it prints:
        """
        mockingbird.yaml: nothing to change
        """

    Scenario: A single change is counted in the singular
      Given she runs "mockingbird-fleet apply"
      And she changes "mail: { target: resend }" to "mail: { target: resend, durability: strict }" in the file
      When she runs "mockingbird-fleet apply"
      Then it prints:
        """
        ~ emulator acme-staging/mail  (durability buffered → strict)
        mockingbird.yaml: 1 change applied
        """

    Scenario: An admin API key applies the file, as a pipeline would
      Given she runs "mockingbird-fleet apply"
      And Ada has an organization key "ci" for "acme" with the admin role
      And she changes "mail: { target: resend }" to "mail: { target: resend, durability: strict }" in the file
      When the key "ci" runs "mockingbird-fleet apply"
      Then it exits with code 0
      And the organization "acme" is managed by the file the key "ci" applied

  Rule: apply deletes only with --prune

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
                  mail: { target: resend, durability: strict }
        """
      And an SDK has sent an email through the "mail" emulator of "acme-staging"
      And she removes the line "mail: { target: resend, durability: strict }" from the file

    Scenario: Without --prune, apply fails and says what would be deleted
      When she runs "mockingbird-fleet apply"
      Then it fails, saying:
        """
        Applying this file would delete emulator acme-staging/mail. Declare them in mockingbird.yaml to keep them, or apply with prune=true to delete them.
        """
      And it prints nothing to standard output
      And the fleet "acme-staging" runs resend and mail
      And the email can be read back from the "mail" emulator of "acme-staging"

    Scenario: With --prune, apply deletes what the file no longer declares
      When she runs "mockingbird-fleet apply --prune"
      Then it exits with code 0
      And it prints:
        """
        - emulator acme-staging/mail  (its stored state is erased)
        mockingbird.yaml: 1 change applied
        """
      And the fleet "acme-staging" runs resend
      And object storage holds nothing for the "mail" emulator of "acme-staging"

    Scenario: plan shows the deletion without needing --prune
      When she runs "mockingbird-fleet plan"
      Then it exits with code 0
      And it prints:
        """
        - emulator acme-staging/mail  (its stored state is erased)
        mockingbird.yaml: 1 change planned
        """
      And the fleet "acme-staging" runs resend and mail

  Rule: Where Fleet Cloud is, and who is asking, come from flags and the environment

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
                  resend: {}
        """

    Scenario: Without an address, the CLI says which flag or variable to set
      When she runs "mockingbird-fleet plan" without MOCKINGBIRD_FLEET_URL
      Then it fails, saying:
        """
        mockingbird-fleet: Fleet Cloud URL required: --url or MOCKINGBIRD_FLEET_URL
        """
      And its error output is a message, not a stack trace

    Scenario: Without a credential, the CLI says which variable to set
      When she runs "mockingbird-fleet apply" without MOCKINGBIRD_FLEET_TOKEN
      Then it fails, saying:
        """
        mockingbird-fleet: Credential required: set MOCKINGBIRD_FLEET_TOKEN to a personal token or an admin API key
        """
      And Ada belongs to no organizations

    Scenario: --url names Fleet Cloud when the variable is not set
      When she runs "mockingbird-fleet apply --url <fleet-cloud>/" without MOCKINGBIRD_FLEET_URL
      Then it exits with code 0
      And the fleet "acme-staging" runs resend

    Scenario: --token-env names another variable that holds the credential
      When she runs "mockingbird-fleet apply --token-env ACME_FLEET_TOKEN" with her credential in ACME_FLEET_TOKEN
      Then it exits with code 0
      And the fleet "acme-staging" runs resend

    Scenario: --file names a declaration kept somewhere else
      Given Ada's repository holds this fleet configuration "fleets/acme.yaml":
        """
        version: 1
        organization: <acme>
        projects:
          web:
            fleets:
              <acme-preview>:
                services:
                  stripe: {}
        """
      When she runs "mockingbird-fleet apply --file fleets/acme.yaml"
      Then it exits with code 0
      And it prints:
        """
        + organization acme
        + project web
        + fleet acme-preview
        + emulator acme-preview/stripe  (buffered)
        fleets/acme.yaml: 4 changes applied
        """

    Scenario: A credential Fleet Cloud does not accept is reported, and the exit code is 1
      When she runs "mockingbird-fleet apply" with her credential in SOME_OTHER_VARIABLE
      Then it exits with code 1

    Scenario: A Fleet Cloud that cannot be reached is reported by its address
      When she runs "mockingbird-fleet plan" while Fleet Cloud cannot be reached
      Then it exits with code 1
      And its error output is a message, not a stack trace

    Scenario: Someone who may not apply is told why, and the exit code is 1
      Given she runs "mockingbird-fleet apply"
      And Bo has joined "acme" with the member role
      When Bo runs "mockingbird-fleet apply"
      Then it fails, saying:
        """
        This needs the admin role or higher
        """

  Rule: --json prints the result for a program to read

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
                  resend: {}
        """

    Scenario: plan --json prints the plan as one JSON document
      When she runs "mockingbird-fleet plan --json"
      Then it exits with code 0
      And its standard output is one JSON document: a plan with 4 changes

    Scenario: apply --json prints the applied result as one JSON document
      When she runs "mockingbird-fleet apply --json"
      Then it exits with code 0
      And its standard output is one JSON document: an applied result with 4 changes

  Rule: A mistake in the file is reported before anything is sent

    Scenario: The mistakes are listed with their paths, and Fleet Cloud is never called
      Given Ada's repository holds this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        projects:
          web:
            fleets:
              <acme-staging>:
                access: public
                services:
                  resend: { durability: eventual }
        """
      When she runs "mockingbird-fleet apply" while Fleet Cloud cannot be reached
      Then it fails, saying:
        """
        mockingbird-fleet: mockingbird.yaml is invalid:
          projects.web.fleets.acme-staging.access: must be one of open, key
          projects.web.fleets.acme-staging.services.resend.durability: must be one of strict, buffered, ephemeral
        """
      And it prints nothing to standard output

    Scenario: A mistake only Fleet Cloud can find is reported with its path too
      Given Ada's repository holds this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        projects:
          web:
            fleets:
              <acme-staging>:
                services:
                  db: { target: postgres, protocol: postgres }
        """
      When she runs "mockingbird-fleet apply"
      Then it exits with code 1
      And Ada belongs to no organizations

    Scenario: A repository without a mockingbird.yaml is reported, not a stack trace
      Given Ada is signed in
      When Ada runs "mockingbird-fleet plan"
      Then it exits with code 1
      And its error output is a message, not a stack trace
