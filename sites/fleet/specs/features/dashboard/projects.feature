@dashboard
Feature: Projects in the dashboard
  A project groups the fleets of one application. The first tab of an organization lists its
  projects; a project's own page lists its fleets and its settings. Creating, renaming and
  deleting a project, and creating a fleet in it, each happen on a screen of their own, reached by
  a link from the page they change.

  Background:
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"

  Rule: An organization lists its projects

    Scenario: An organization without projects says what a project is for
      When they open the organization "Acme"
      Then they see "No projects yet"
      And they see "A project groups the fleets of one application. Create the first one."

    Scenario: Creating a project opens it, noting that it was just created
      When they open the organization "Acme"
      And they follow "New project"
      Then they see the page "New project"
      And the screen is the "project.new" form
      When they type "Web app" into "Name"
      And they press "Create project"
      Then they see the page "Web app"
      And they see the note "Created just now"
      And they see "No fleets yet"
      And they see "Create one, then add the emulators it should run."

    Scenario: Cancel returns to the organization and creates nothing
      When they open the organization "Acme"
      And they follow "New project"
      And they type "Web app" into "Name"
      And they cancel
      Then they see the page "Acme"
      And they see "No projects yet"

    Scenario: An empty name is pointed out under the field
      When they open the organization "Acme"
      And they follow "New project"
      And they press "Create project"
      Then the field "Name" says "Enter a name for the project."
      And they see the page "New project"

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

  Rule: A project is renamed and deleted on screens of their own

    Background:
      Given Ada has a project "Web app" in "Acme"

    Scenario: Renaming a project notes the new name beside it
      When they open the project "Web app"
      And they follow "Rename the project"
      Then they see the page "Rename Web app"
      And the field "Name" holds "Web app"
      When they type "Storefront" into "Name"
      And they press "Rename project"
      Then they see the page "Storefront"
      And the setting "Name" reads "Storefront"
      And the setting "Name" is noted "Renamed just now"
      And the address is that of the project "Web app"

    Scenario: An empty name is pointed out under the field when renaming
      When they open the project "Web app"
      And they follow "Rename the project"
      And they clear "Name"
      And they press "Rename project"
      Then the field "Name" says "Enter a name for the project."
      And exactly 1 problem is pointed out

    Scenario: Cancelling the rename keeps the name
      When they open the project "Web app"
      And they follow "Rename the project"
      And they type "Storefront" into "Name"
      And they cancel
      Then they see the page "Web app"
      And no note is shown

    Scenario: Deleting a project says what goes with it, then returns to the organization
      Given Ada has a fleet "Staging" in the project "Web app"
      When they open the project "Web app"
      And they follow "Delete project…"
      Then they see the page "Delete Web app"
      And they see "This deletes the project and its 1 fleet (Staging) with all of their stored emulator state."
      When they press "Delete project"
      Then they see the page "Acme"
      And they see the note "Web app was deleted just now."
      And they see "No projects yet"

    Scenario: Cancelling the deletion keeps the project
      When they open the project "Web app"
      And they follow "Delete project…"
      And they cancel
      Then they see the page "Web app"
      When they reload the page
      Then they see the page "Web app"

  Rule: A project lists its fleets, and new ones are created from it

    Background:
      Given Ada has a project "Web app" in "Acme"

    Scenario: Creating a fleet without a slug gives it one
      When they open the project "Web app"
      And they follow "New fleet"
      And they type "Staging" into "Name"
      And they press "Create fleet"
      Then they see the page "Staging"
      And they see the note "Created just now"
      And they see "This fleet has no emulators"
      And the fleet's address on screen is under "/f/"

    Scenario: Creating a fleet with a slug puts it at that address
      When they open the project "Web app"
      And they follow "New fleet"
      And they type "Staging" into "Name"
      And they type a slug of their own "staging" into "URL slug (optional)"
      And they press "Create fleet"
      Then they see the page "Staging"
      And the fleet's address on screen ends with the slug "staging"

    Scenario: A slug that is already taken is refused under the slug field
      Given Ada has a fleet "Taken" in the project "Web app" at the slug "taken"
      When they open the project "Web app"
      And they follow "New fleet"
      And they type "Second" into "Name"
      And they type a slug of their own "taken" into "URL slug (optional)"
      And they press "Create fleet"
      Then the field "URL slug (optional)" says "already taken"
      And exactly 1 problem is pointed out
      And they see the page "New fleet"

    Scenario: A slug that cannot be an address is pointed out before asking the server
      When they open the project "Web app"
      And they follow "New fleet"
      And they type "Staging" into "Name"
      And they type "Not a slug!" into "URL slug (optional)"
      And they press "Create fleet"
      Then the field "URL slug (optional)" says "Use lowercase letters, digits and hyphens"

    Scenario: Cancel returns to the project and creates no fleet
      When they open the project "Web app"
      And they follow "New fleet"
      And they type "Staging" into "Name"
      And they cancel
      Then they see the page "Web app"
      And they see "No fleets yet"

    Scenario: Fleets are listed with their address and how many emulators they run
      Given Ada has a fleet "Staging" in the project "Web app" with a "stripe" emulator named "stripe"
      And Ada has a fleet "CI" in the project "Web app"
      When they open the project "Web app"
      Then the fleet "Staging" is listed with "1 emulator"
      And the fleet "CI" is listed with "0 emulators"
      When they follow the fleet "Staging"
      Then they see the page "Staging"
      And the address is that of the fleet "Staging"
