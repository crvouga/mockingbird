@dashboard
Feature: Projects in the dashboard
  A project groups the fleets of one application. The first tab of an organization lists its
  projects; a project's own page lists its fleets and is where fleets are created.

  Background:
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"

  Rule: An organization lists its projects

    Scenario: An organization without projects says what a project is for
      When they open the organization "Acme"
      Then they see "No projects yet"
      And they see "A project groups the fleets of one application."

    Scenario: Creating a project opens it
      When they open the organization "Acme"
      And they type "Web app" into "Project name"
      And they press "Create project"
      Then they see the page "Web app"
      And they see "No fleets yet"
      And they see "Create one, then pick the emulators it should run."

    Scenario: Projects are listed and open their page
      Given Ada has a project "Web app" in "Acme"
      And Ada has a project "Mobile app" in "Acme"
      When they open the organization "Acme"
      And they follow the project "Mobile app"
      Then they see the page "Mobile app"
      And the address is that of the project "Mobile app"

    Scenario: A project leads back to its organization
      Given Ada has a project "Web app" in "Acme"
      When they open the project "Web app"
      And they follow "Acme"
      Then they see the page "Acme"
      And the address is that of the organization "Acme"

  Rule: A project lists its fleets and creates new ones

    Background:
      Given Ada has a project "Web app" in "Acme"

    Scenario: Creating a fleet without a slug gives it one
      When they open the project "Web app"
      And they type "Staging" into "Fleet name"
      And they press "Create fleet"
      Then they see the page "Staging"
      And they see "This fleet is empty"
      And the fleet's address on screen is under "/f/"

    Scenario: Creating a fleet with a slug puts it at that address
      When they open the project "Web app"
      And they type "Staging" into "Fleet name"
      And they type a slug of their own "staging" into "URL slug"
      And they press "Create fleet"
      Then they see the page "Staging"
      And the fleet's address on screen ends with the slug "staging"

    Scenario: A slug that is already taken is refused where it was typed
      Given Ada has a fleet "Taken" in the project "Web app" at the slug "taken"
      When they open the project "Web app"
      And they type "Second" into "Fleet name"
      And they type a slug of their own "taken" into "URL slug"
      And they press "Create fleet"
      Then they see the error "already taken"
      And they see the page "Web app"

    Scenario: Fleets are listed with their address and how many emulators they run
      Given Ada has a fleet "Staging" in the project "Web app" with a "stripe" emulator named "stripe"
      And Ada has a fleet "CI" in the project "Web app"
      When they open the project "Web app"
      Then the fleet "Staging" is listed with "1 emulator"
      And the fleet "CI" is listed with "0 emulators"
      When they follow the fleet "Staging"
      Then they see the page "Staging"
      And the address is that of the fleet "Staging"

    Scenario: Deleting a project asks first, then returns to the organization
      When they open the project "Web app"
      And they press "Delete project" and confirm
      Then they were asked "Delete Web app and all of its fleets?"
      And they see the page "Acme"
      And they see "No projects yet"

    Scenario: Declining the question keeps the project
      When they open the project "Web app"
      And they press "Delete project" and decline
      And they reload the page
      Then they see the page "Web app"
