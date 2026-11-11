@tenancy
Feature: Projects
  A project groups an organization's fleets, and is the boundary a project key is confined to.

  Background:
    Given Ada owns an organization "Acme"

  Rule: Projects belong to one organization

    Scenario: A new project appears in its organization
      When Ada creates a project named "Web" in "Acme"
      Then the response status is 201
      And the project "Web" belongs to "Acme"
      And the projects of "Acme" are "Web"

    Scenario: An organization lists all of its projects
      Given Ada has a project "Web" in "Acme"
      And Ada has a project "Mobile" in "Acme"
      And Grace owns an organization "Globex"
      And Grace has a project "Api" in "Globex"
      Then the projects of "Acme" are "Web, Mobile"

    Scenario: An organization with no projects lists none
      Then the projects of "Acme" are ""

    Scenario: A project can be looked up by anyone in its organization
      Given Ada has a project "Web" in "Acme"
      And Grace has joined "Acme" with the viewer role
      When Grace asks for the project "Web"
      Then the request succeeds

  Rule: A project's slug is unique within its organization

    Scenario: A slug is made from the name when none is chosen
      When Ada creates a project named "Web App" in "Acme"
      Then the project "Web App" has a slug starting with "web-app-"

    Scenario: The creator may choose the slug
      When Ada creates a project named "Web" in "Acme" with the slug "web"
      Then the project "Web" has the slug "web"

    Scenario: A slug already used in the organization is refused
      Given Ada creates a project named "Web" in "Acme" with the slug "web"
      When Ada creates a project named "Website" in "Acme" with the slug "web"
      Then the request is refused as "conflict"
      And the response status is 409
      And the projects of "Acme" are "Web"

    Scenario: Two organizations may use the same project slug
      Given Ada creates a project named "Web" in "Acme" with the slug "web"
      And Grace owns an organization "Globex"
      When Grace creates a project named "Web too" in "Globex" with the slug "web"
      Then the response status is 201

    Scenario Outline: The malformed slug "<slug>" is refused
      When Ada creates a project named "Web" in "Acme" with the slug "<slug>"
      Then the request is refused as "invalid_request"
      And the projects of "Acme" are ""

      Examples:
        | slug     |
        | Web      |
        | web app  |
        | -web     |
        | web-     |

    Scenario: A project needs a name
      When Ada creates a project named "" in "Acme"
      Then the request is refused as "invalid_request"
      And the projects of "Acme" are ""

  Rule: A project can be renamed, and its slug stays

    Scenario: Renaming changes the name only
      Given Ada creates a project named "Web" in "Acme" with the slug "web"
      When Ada renames the project "Web" to "Website"
      Then the request succeeds
      And the projects of "Acme" are "Website"
      And the project "Web" has the slug "web"

    Scenario: A blank name is refused
      Given Ada has a project "Web" in "Acme"
      When Ada renames the project "Web" to ""
      Then the request is refused as "invalid_request"
      And the projects of "Acme" are "Web"

  Rule: Deleting a project deletes its fleets

    Background:
      Given Ada has a project "Web" in "Acme"
      And Ada has a fleet "Staging" in the project "Web" with a "resend" emulator named "mail"
      And Ada has a fleet "Preview" in the project "Web"
      And Ada has a project "Mobile" in "Acme"
      And Ada has a fleet "Beta" in the project "Mobile"

    Scenario: The project and its fleets are gone
      When Ada deletes the project "Web"
      Then the request succeeds
      And the project "Web" no longer exists for Ada
      And the fleet "Staging" no longer exists for Ada
      And the fleet "Preview" no longer exists for Ada
      And nothing is served at the address of the fleet "Staging"

    Scenario: The rest of the organization is untouched
      When Ada deletes the project "Web"
      Then the projects of "Acme" are "Mobile"
      And the fleet "Beta" still exists for Ada

    Scenario: The state its emulators stored is removed
      Given the "mail" emulator of the fleet "Staging" has stored state
      When Ada deletes the project "Web"
      Then no emulator state remains stored for the fleet "Staging"
