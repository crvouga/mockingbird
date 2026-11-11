@declarative
Feature: The file is the whole truth
  Applying makes an organization's projects, fleets and emulators match the file, so what the
  file no longer declares has to go. Deleting is never a surprise: it happens only when prune is
  asked for. Without it the apply is refused, says what would be deleted, and changes nothing.

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
        api:
          fleets:
            <acme-api>:
              services:
                resend: { durability: strict }
      """
    And an SDK has sent an email through the "resend" emulator of "acme-api"
    And an SDK has sent an email through the "resend" emulator of "acme-staging"
    And an SDK has sent an email through the "mail" emulator of "acme-staging"

  Rule: A plan says what would be deleted

    Scenario: An emulator the file no longer declares is planned for deletion
      When she removes the line "mail: { target: resend, durability: strict }" from the file
      And she plans it
      Then the only change reported is:
        | delete | emulator | acme-staging/mail | its stored state is erased |

    Scenario: A project the file no longer declares is planned for deletion with its fleets
      When she changes the file to:
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
      And she plans it
      Then the changes reported are:
        | change | kind    | name     | detail                                                 |
        | delete | fleet   | acme-api | its URL stops answering and its stored state is erased |
        | delete | project | api      |                                                        |

    Scenario: A fleet the file no longer declares is planned for deletion, and its project stays
      When she changes the file to:
        """
        version: 1
        organization: <acme>
        projects:
          web: {}
          api:
            fleets:
              <acme-api>:
                services:
                  resend: { durability: strict }
        """
      And she plans it
      Then the only change reported is:
        | delete | fleet | acme-staging | its URL stops answering and its stored state is erased |

  Rule: Without prune, an apply that would delete is refused and changes nothing

    Scenario: Removing an emulator from the file is refused without prune
      When she removes the line "mail: { target: resend, durability: strict }" from the file
      And she applies it
      Then the request is refused as "prune_required"
      And the refusal lists what would be deleted:
        | emulator | acme-staging/mail |
      And the fleet "acme-staging" runs resend and mail
      And the email can be read back from the "mail" emulator of "acme-staging"
      And Fleet Cloud still matches the file that was applied

    Scenario: Everything that would be deleted is listed at once
      When she changes the file to:
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
      And she applies it
      Then the response status is 409
      And the refusal lists what would be deleted:
        | emulator | acme-staging/mail |
        | fleet    | acme-api          |
        | project  | api               |
      And Fleet Cloud still matches the file that was applied

    Scenario: The other changes in a refused file are not applied either
      When she changes the file to:
        """
        version: 1
        organization: <acme>
        name: Acme Inc
        projects:
          web:
            fleets:
              <acme-staging>:
                access: key
                services:
                  resend: { durability: strict }
                  mail: { target: resend, durability: strict }
                  stripe: {}
        """
      And she applies it
      Then the request is refused as "prune_required"
      And the fleet "acme-staging" runs resend and mail
      And the fleet "acme-staging" is configured as:
        | access | open |
      And Fleet Cloud still matches the file that was applied

  Rule: With prune, what the file no longer declares is deleted

    Scenario: A pruned emulator stops answering and its stored state is erased
      Given object storage holds state for the "mail" emulator of "acme-staging"
      When she removes the line "mail: { target: resend, durability: strict }" from the file
      And she applies it with prune
      Then the only change reported is:
        | delete | emulator | acme-staging/mail | its stored state is erased |
      And the fleet "acme-staging" runs resend
      And Fleet Cloud serves nothing as "mail" in the fleet "acme-staging"
      And object storage holds nothing for the "mail" emulator of "acme-staging"

    Scenario: Pruning one emulator leaves the others and their state alone
      When she removes the line "mail: { target: resend, durability: strict }" from the file
      And she applies it with prune
      Then object storage holds state for the "resend" emulator of "acme-staging"
      And object storage holds state for the "resend" emulator of "acme-api"

    Scenario: A pruned fleet stops answering and all its stored state is erased
      Given object storage holds state for the "resend" emulator of "acme-staging"
      When she changes the file to:
        """
        version: 1
        organization: <acme>
        projects:
          web: {}
          api:
            fleets:
              <acme-api>:
                services:
                  resend: { durability: strict }
        """
      And she applies it with prune
      Then nothing answers at the URL of the fleet "acme-staging"
      And object storage holds nothing for "acme-staging"
      And the organization "acme" has exactly these projects and fleets:
        | project | name | fleets   |
        | web     | web  |          |
        | api     | api  | acme-api |

    Scenario: A pruned project takes its fleets and their stored state with it
      When she changes the file to:
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
      And she applies it with prune
      Then the changes reported are:
        | change | kind    | name     | detail                                                 |
        | delete | fleet   | acme-api | its URL stops answering and its stored state is erased |
        | delete | project | api      |                                                        |
      And nothing answers at the URL of the fleet "acme-api"
      And object storage holds nothing for "acme-api"
      And the organization "acme" has exactly these projects and fleets:
        | project | name | fleets       |
        | web     | web  | acme-staging |

    Scenario: A file that declares no projects empties the organization but keeps it
      When she changes the file to:
        """
        version: 1
        organization: <acme>
        projects: {}
        """
      And she applies it with prune
      Then the organization "acme" has no projects
      And object storage holds nothing for "acme-staging"
      And object storage holds nothing for "acme-api"
      And Ada is the owner of the organization "acme"

    Scenario: Prune deletes nothing when the file still declares everything
      When she applies it with prune
      Then nothing is reported to change
      And the email can be read back from the "mail" emulator of "acme-staging"

    Scenario: A slug freed by pruning a fleet can be declared again, and starts clean
      Given she changes "<acme-api>:" to "<acme-edge>:" in the file
      And she has applied it with prune
      When she changes "<acme-edge>:" to "<acme-api>:" in the file
      And she applies it with prune
      Then the fleet "acme-api" runs resend
      And object storage holds nothing for the "resend" emulator of "acme-api"
