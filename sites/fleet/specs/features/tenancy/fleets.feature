@tenancy
Feature: Fleets as resources
  A fleet is a named set of emulators at a stable address. This feature covers creating, changing
  and deleting fleets; what a fleet serves at its address is specified elsewhere.

  Background:
    Given Ada owns an organization "Acme"
    And Ada has a project "Web" in "Acme"

  Rule: A fleet lives at a stable address

    Scenario: A fleet can be created empty
      When Ada creates a fleet named "Staging" in "Web"
      Then the response status is 201
      And the fleet "Staging" has no emulators
      And the fleet "Staging" is open to anyone who knows its address
      And the fleet "Staging" belongs to the project "Web"

    Scenario: A fleet's address is the fleet host followed by its slug
      When Ada creates a fleet named "Staging" in "Web"
      Then the fleet "Staging" is addressed by its slug

    Scenario: A fleet can be created together with its emulators
      When Ada creates a fleet named "Staging" in "Web" with the emulators:
        | name     | emulates | durability |
        | payments | stripe   | strict     |
        | mail     | resend   |            |
      Then the response status is 201
      And the fleet "Staging" has the emulators:
        | name     | emulates | durability |
        | payments | stripe   | strict     |
        | mail     | resend   | buffered   |
      And each emulator of the fleet "Staging" is addressed beneath the fleet, by its name

    Scenario: A slug is made from the name when none is chosen
      When Ada creates a fleet named "Nightly Build" in "Web"
      Then the fleet "Nightly Build" has a slug starting with "nightly-build-"

    Scenario: Choosing the slug chooses the address
      When Ada creates a fleet named "Checkout" in "Web" with the slug "checkout"
      Then the fleet "Checkout" is addressed as "/f/checkout"

    Scenario: The slug is permanent, so the address survives a rename
      Given Ada creates a fleet named "Checkout" in "Web" with the slug "checkout"
      When Ada renames the fleet "Checkout" to "Checkout v2"
      Then the request succeeds
      And the fleet "Checkout" is now called "Checkout v2"
      And the fleet "Checkout" is addressed as "/f/checkout"

    Scenario: A fleet cannot be moved to another slug
      Given Ada creates a fleet named "Checkout" in "Web" with the slug "checkout"
      When Ada tries to move the fleet "Checkout" to the slug "payments"
      Then the request is refused as "invalid_request"
      And the fleet "Checkout" is addressed as "/f/checkout"

  Rule: A fleet slug is unique across the whole service

    Scenario: A slug taken by another organization is refused
      Given Ada creates a fleet named "Checkout" in "Web" with the slug "checkout"
      And Grace owns an organization "Globex"
      And Grace has a project "Api" in "Globex"
      When Grace creates a fleet named "Ours" in "Api" with the slug "checkout"
      Then the request is refused as "conflict"
      And the response status is 409
      And the message says "is already taken"
      And the project "Api" has no fleets

    Scenario: Creating the same slug twice answers "conflict", so setup can be repeated safely
      Given Ada creates a fleet named "Checkout" in "Web" with the slug "checkout"
      When Ada creates a fleet named "Checkout again" in "Web" with the slug "checkout"
      Then the request is refused as "conflict"
      And the fleet "Checkout" is now called "Checkout"
      And the fleets of the project "Web" are "Checkout"

  Rule: An invalid fleet is refused, with every problem listed

    Scenario Outline: A fleet with <problem> is refused
      When Ada tries to create a fleet in "Web" with <problem>
      Then the request is refused as "invalid_request"
      And the response status is 400
      And the problems listed include "<detail>"
      And the project "Web" has no fleets

      Examples:
        | problem                      | detail                                |
        | no name                      | body.name: required                   |
        | a blank name                 | body.name: must be at least 1         |
        | a name of 81 characters      | body.name: must be at most 80         |
        | a malformed slug             | body.slug: Lowercase letters, digits  |
        | an unknown access setting    | body.access: must be one of open, key |
        | an unrecognised field        | body.colour: unknown field            |
        | an emulator without a target | body.emulators.mail.target: required  |

    Scenario: Every problem is reported at once
      When Ada tries to create a fleet in "Web" with several problems at once
      Then the request is refused as "invalid_request"
      And 4 problems are listed

    Scenario: An emulator's name must be a slug
      When Ada creates a fleet named "Staging" in "Web" with the emulators:
        | name     | emulates |
        | Bad_Name | resend   |
      Then the request is refused as "invalid_request"
      And the message says "Emulator names are lowercase letters, digits and hyphens"
      And the project "Web" has no fleets

    Scenario: A fleet naming an unknown emulator is not created
      When Ada creates a fleet named "Staging" in "Web" with the emulators:
        | name | emulates       |
        | mail | no-such-vendor |
      Then the request is refused as "unknown_emulator"
      And the response status is 400
      And the project "Web" has no fleets

  Rule: A fleet can be renamed and opened or closed to anonymous callers

    Background:
      Given Ada has a fleet "Staging" in the project "Web"

    Scenario: Renaming a fleet
      When Ada renames the fleet "Staging" to "Pre-production"
      Then the request succeeds
      And the fleets of the project "Web" are "Pre-production"

    Scenario: Requiring an API key to call a fleet
      When Ada restricts the fleet "Staging" to callers with an API key
      Then the request succeeds
      And the fleet "Staging" is closed to callers without an API key

    Scenario: Opening a fleet again
      Given Ada restricts the fleet "Staging" to callers with an API key
      When Ada opens the fleet "Staging" to anyone who knows its address
      Then the request succeeds
      And the fleet "Staging" is open to anyone who knows its address

    Scenario: A fleet can be created already closed
      When Ada creates a fleet named "Private" in "Web" that needs an API key
      Then the fleet "Private" is closed to callers without an API key

    Scenario: An unknown access setting is refused
      When Ada sets the access of the fleet "Staging" to "secret"
      Then the request is refused as "invalid_request"
      And the fleet "Staging" is open to anyone who knows its address

    Scenario: A blank name is refused
      When Ada renames the fleet "Staging" to ""
      Then the request is refused as "invalid_request"
      And the fleet "Staging" is now called "Staging"

  Rule: Fleets are listed by project and deleted with their stored state

    Scenario: A project lists its own fleets
      Given Ada has a fleet "Staging" in the project "Web"
      And Ada has a fleet "Preview" in the project "Web"
      And Ada has a project "Mobile" in "Acme"
      And Ada has a fleet "Beta" in the project "Mobile"
      Then the fleets of the project "Web" are "Staging, Preview"
      And the fleets of the project "Mobile" are "Beta"

    Scenario: A deleted fleet is gone
      Given Ada has a fleet "Staging" in the project "Web"
      When Ada deletes the fleet called "Staging"
      Then the request succeeds
      And the fleet "Staging" no longer exists for Ada
      And the project "Web" has no fleets
      And nothing is served at the address of the fleet "Staging"

    Scenario: Deleting a fleet removes the state its emulators stored
      Given Ada has a fleet "Staging" in the project "Web" with a "resend" emulator named "mail"
      And the "mail" emulator of the fleet "Staging" has stored state
      When Ada deletes the fleet called "Staging"
      Then no emulator state remains stored for the fleet "Staging"

    Scenario: Deleting a fleet that is already gone finds nothing
      Given Ada has a fleet "Staging" in the project "Web"
      And Ada deletes the fleet called "Staging"
      When Ada deletes the fleet called "Staging"
      Then the request is refused as "not_found"
