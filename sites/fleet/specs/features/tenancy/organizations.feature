@tenancy
Feature: Organizations
  An organization is the tenant. It owns projects, fleets, members, invites and API keys, and
  nothing in one organization is visible from another.

  Rule: Whoever creates an organization owns it

    Scenario: The creator becomes the owner
      When Ada creates an organization named "Acme"
      Then the response status is 201
      And Ada is an owner of "Acme"
      And the members of "Acme" are:
        | person | role  |
        | Ada    | owner |

    Scenario: An organization key cannot create organizations
      Given Ada owns an organization "Acme"
      And Ada has an organization key "ci" for "Acme" with the admin role
      When the key "ci" creates an organization named "Another"
      Then the request is refused as "forbidden"

    Scenario: Organizations may share a name
      Given Ada owns an organization "Acme"
      When Grace creates an organization named "Acme"
      Then the request succeeds
      And Grace belongs to 1 organization

  Rule: An organization's slug is unique and well-formed

    Scenario: A slug is made from the name when none is chosen
      When Ada creates an organization named "Acme Rockets"
      Then the organization "Acme Rockets" has a slug starting with "acme-rockets-"

    Scenario: The creator may choose the slug
      When Ada creates an organization named "Acme" with the slug "acme"
      Then the request succeeds
      And the organization "Acme" has the slug "acme"

    Scenario: A slug that is taken is refused
      Given Ada owns an organization "Acme" with the slug "acme"
      When Grace creates an organization named "Globex" with the slug "acme"
      Then the request is refused as "conflict"
      And the response status is 409
      And the message says "is already taken"
      And Grace belongs to no organizations

    Scenario Outline: The malformed slug "<slug>" is refused
      When Ada tries to create an organization with the malformed slug "<slug>"
      Then the request is refused as "invalid_request"
      And the response status is 400
      And Ada belongs to no organizations

      Examples:
        | slug                                      |
        | Acme                                      |
        | acme inc                                  |
        | -acme                                     |
        | acme-                                     |
        | acme_inc                                  |
        | a-slug-that-is-forty-one-characters-long1 |

    Scenario Outline: An organization with <problem> is refused
      When Ada tries to create an organization with <problem>
      Then the request is refused as "invalid_request"
      And Ada belongs to no organizations

      Examples:
        | problem                 |
        | no name                 |
        | a blank name            |
        | a name of 81 characters |
        | an unrecognised field   |

  Rule: People see only the organizations they belong to

    Scenario: The list holds your own organizations and nobody else's
      Given Ada owns an organization "Acme"
      And Ada owns an organization "Side project"
      And Grace owns an organization "Globex"
      When Ada lists the organizations they belong to
      Then the organizations listed are "Acme, Side project"

    Scenario: Someone who belongs to nothing sees an empty list
      Given Ada owns an organization "Acme"
      When Grace lists the organizations they belong to
      Then the organizations listed are ""

    Scenario: The list tells each person their own role
      Given Ada owns an organization "Acme"
      And Grace has joined "Acme" with the viewer role
      When Grace lists the organizations they belong to
      Then the organizations listed are "Acme"
      And Grace is a viewer of "Acme"

  Rule: An organization can be renamed, and its slug stays

    Scenario: Renaming changes the name only
      Given Ada owns an organization "Acme"
      When Ada renames the organization "Acme" to "Acme Corporation"
      Then the request succeeds
      And the organization "Acme" is now called "Acme Corporation"
      And the organization "Acme" still has its original slug

    Scenario: A blank name is refused
      Given Ada owns an organization "Acme"
      When Ada renames the organization "Acme" to ""
      Then the request is refused as "invalid_request"
      And the organization "Acme" is now called "Acme"

  Rule: Deleting an organization deletes everything in it

    Background:
      Given Ada owns an organization "Acme"
      And Ada has a project "Web" in "Acme"
      And Ada has a fleet "Staging" in the project "Web" with a "resend" emulator named "mail"
      And Grace has joined "Acme" with the admin role

    Scenario: It disappears for everyone who belonged to it
      When Ada deletes the organization "Acme"
      Then the request succeeds
      And Ada belongs to no organizations
      And Grace belongs to no organizations
      And the organization "Acme" no longer exists for Ada

    Scenario: Its projects and fleets are gone
      When Ada deletes the organization "Acme"
      Then the project "Web" no longer exists for Ada
      And the fleet "Staging" no longer exists for Ada
      And nothing is served at the address of the fleet "Staging"

    Scenario: Its keys stop working
      Given Ada has an organization key "ci" for "Acme" with the member role
      And Ada has a project key "web-ci" for the project "Web" with the member role
      When Ada deletes the organization "Acme"
      Then the key "ci" is no longer accepted
      And the key "web-ci" is no longer accepted

    Scenario: The state its emulators stored is removed
      Given the "mail" emulator of the fleet "Staging" has stored state
      When Ada deletes the organization "Acme"
      Then no emulator state remains stored for the fleet "Staging"

    Scenario: Its pending invites stop working
      Given Ada has invited Linus to "Acme" as a member
      When Ada deletes the organization "Acme"
      And Linus accepts their invite
      Then the request is refused as "not_found"
      And Linus belongs to no organizations

    Scenario: Other organizations are untouched
      Given Grace owns an organization "Globex"
      And Grace has a project "Api" in "Globex"
      When Ada deletes the organization "Acme"
      Then the project "Api" still exists for Grace
