@declarative
Feature: A managed organization is changed by its file, not by hand
  Once a mockingbird.yaml has been applied, the file and Fleet Cloud agree, and they stay in
  agreement because the file is the only way to change what it declares. Everything a file does
  not declare stays available by hand: operating the fleets, and managing people and keys.
  Releasing the organization hands control back without deleting anything.

  Background:
    Given Ada has applied this mockingbird.yaml:
      """
      version: 1
      organization: <acme>
      name: Acme
      projects:
        web:
          fleets:
            <acme-staging>:
              services:
                resend: { durability: strict }
      """

  Rule: What the file declares cannot be changed by hand

    Scenario Outline: Ada cannot <change> by hand
      When Ada tries by hand to <change>
      Then that was the API operation "<operation>"
      And the request is refused as "managed_by_declaration"
      And the refusal says how to change it instead
      And Fleet Cloud still matches the file that was applied

      Examples:
        | change                          | operation      |
        | rename the organization         | updateOrg      |
        | add a project                   | createProject  |
        | rename a project                | updateProject  |
        | delete a project                | deleteProject  |
        | add a fleet                     | createFleet    |
        | change a fleet's access         | updateFleet    |
        | delete a fleet                  | deleteFleet    |
        | add an emulator                 | putEmulator    |
        | change an emulator's durability | updateEmulator |
        | remove an emulator              | deleteEmulator |

    Scenario: Those are all the changes only a file may make
      Then the changes only a file may make are exactly:
        | updateOrg      |
        | createProject  |
        | updateProject  |
        | deleteProject  |
        | createFleet    |
        | updateFleet    |
        | deleteFleet    |
        | putEmulator    |
        | updateEmulator |
        | deleteEmulator |

    Scenario: An admin API key is refused just as a person is
      Given Ada has an organization key "ci" for "acme" with the admin role
      When the key "ci" tries by hand to add an emulator
      Then the request is refused as "managed_by_declaration"
      And the fleet "acme-staging" runs resend

    Scenario: Someone who may not change the organization is told that, not about the file
      Given Bo has joined "acme" with the viewer role
      When Bo tries by hand to add a project
      Then the request is refused as "forbidden"

  Rule: Operating fleets, and managing people and keys, stay available

    Scenario Outline: Ada can still <operation>
      Given an SDK has sent an email through the "resend" emulator of "acme-staging"
      Then Ada can still <operation>

      Examples:
        | operation                    |
        | reset an emulator            |
        | save an emulator's state     |
        | download an emulator's state |
        | invite a teammate            |
        | change a member's role       |
        | remove a member              |
        | make an API key              |
        | revoke an API key            |
        | read the audit log           |
        | delete the organization      |

    Scenario: Resetting an emulator by hand clears its state and nothing else
      Given an SDK has sent an email through the "resend" emulator of "acme-staging"
      Then Ada can still reset an emulator
      And the email cannot be read back from the "resend" emulator of "acme-staging"
      And Fleet Cloud still matches the file that was applied

    Scenario: Emulators of a managed organization go on serving SDKs
      When an SDK sends an email through the "resend" emulator of "acme-staging"
      Then the email is accepted

  Rule: Releasing an organization returns it to manual control and deletes nothing

    Scenario: A released organization is configured by hand again
      Given an SDK has sent an email through the "resend" emulator of "acme-staging"
      When Ada releases the organization "acme" from its file
      Then the request succeeds
      And the organization "acme" is configured by hand
      And the fleet "acme-staging" runs resend
      And the email can be read back from the "resend" emulator of "acme-staging"

    Scenario Outline: After a release, Ada can <change> by hand
      Given Ada has released the organization "acme" from its file
      When Ada tries by hand to <change>
      Then the request succeeds

      Examples:
        | change                          |
        | rename the organization         |
        | add a project                   |
        | change a fleet's access         |
        | add an emulator                 |
        | change an emulator's durability |
        | remove an emulator              |
        | delete a fleet                  |

    Scenario Outline: A <role> cannot release the organization
      Given Bo has joined "acme" with the <role> role
      When Bo releases the organization "acme" from its file
      Then the request is refused as "forbidden"
      And the organization "acme" is managed by the file Ada applied

      Examples:
        | role   |
        | viewer |
        | member |

    Scenario: An admin can release the organization
      Given Bo has joined "acme" with the admin role
      When Bo releases the organization "acme" from its file
      Then the request succeeds
      And the organization "acme" is configured by hand

    Scenario: Releasing an organization that is not managed changes nothing
      Given Ada has released the organization "acme" from its file
      When Ada releases the organization "acme" from its file
      Then the request succeeds
      And the organization "acme" is configured by hand

  Rule: A later apply takes control back

    Background:
      Given Ada has released the organization "acme" from its file
      And Ada tries by hand to add an emulator
      And Ada tries by hand to change a fleet's access

    Scenario: The file's plan shows what was changed by hand in the meantime
      When Ada plans it
      Then the changes reported are:
        | change | kind     | name                | detail                     |
        | update | fleet    | acme-staging        | access key → open          |
        | delete | emulator | acme-staging/byhand | its stored state is erased |

    Scenario: Applying the file again undoes the hand edits and manages the organization
      When Ada applies it with prune
      Then the fleet "acme-staging" runs resend
      And the fleet "acme-staging" is configured as:
        | access | open |
      And the organization "acme" is managed by the file Ada applied

    Scenario: Once the file is applied again, hand edits are refused again
      Given Ada has applied it with prune
      When Ada tries by hand to add an emulator
      Then the request is refused as "managed_by_declaration"
