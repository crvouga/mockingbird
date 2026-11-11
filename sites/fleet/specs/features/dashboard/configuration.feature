@dashboard
Feature: An organization's mockingbird.yaml in the dashboard
  The prescribed way to configure an organization is a mockingbird.yaml kept in a repository.
  Every organization has a Configuration tab that shows that file: for an organization
  configured by hand, the file that would reproduce it; for one a file has been applied to, the
  file that was applied, who applied it and when. The tab says how to apply the file to this
  server, and an admin can release the organization from its file there. Wherever the dashboard
  offers to create something by hand, it points to the file first.

  Rule: An organization configured by hand is shown as the file that reproduces it

    Background:
      Given Ada is signed in to the dashboard
      And Ada owns an organization "Acme"
      And Ada has a project "Web app" in "Acme"
      And Ada has a fleet "Staging" in the project "Web app" running:
        | name    | emulator | durability |
        | resend  | resend   | strict     |
        | billing | stripe   | ephemeral  |

    Scenario: Configuration is the tab after Projects
      When they open the organization "Acme"
      And they follow "Configuration"
      Then they see the page "Acme"
      And the "Configuration" tab is the current one
      And the address is that of the "Configuration" tab of "Acme"
      And the screen keeps the design rules

    Scenario: The tab says the organization is configured by hand
      When they open the "Configuration" tab of "Acme"
      Then the setting "Controlled by" reads "Configured by hand"
      And no time of applying is shown
      And they see "This organization is configured by hand."
      And there is no link "Release the organization from mockingbird.yaml"

    Scenario: The file declares every project, fleet and emulator as it is now
      When they open the "Configuration" tab of "Acme"
      Then the file on screen is:
        """
        version: 1
        organization: <Acme>
        name: Acme
        projects:
          <Web app>:
            name: Web app
            fleets:
              <Staging>:
                name: Staging
                access: open
                services:
                  resend: { durability: strict }
                  billing: { target: stripe, durability: ephemeral }
        """

    Scenario: The file can be copied
      When they open the "Configuration" tab of "Acme"
      And they press "Copy mockingbird.yaml"
      Then the clipboard holds the file on screen
      And they see "Copied"

    Scenario: The file can be downloaded
      When they open the "Configuration" tab of "Acme"
      And they download the file
      Then a file named "mockingbird.yaml" is saved, holding the file on screen

    Scenario: The tab explains that applying the file adopts the organization
      When they open the "Configuration" tab of "Acme"
      Then they see "Applying this file changes nothing and puts the organization under the file's control."
      And they see "Members, invites and API keys are not declared in the file: they are people and secrets."

    Scenario: Applying the file on screen changes nothing and puts the organization under it
      When they open the "Configuration" tab of "Acme"
      And the file on screen is applied as it is by Ada
      Then nothing is reported to change
      When they reload the page
      Then the setting "Controlled by" reads "mockingbird.yaml"
      And the configuration was last applied by Ada

    Scenario: An organization with nothing in it is shown an example to start from
      Given Ada owns an organization "Globex"
      When they open the "Configuration" tab of "Globex"
      Then they see "The file declares no projects yet."
      And the example on screen declares a fleet of "Globex" served by this server
      And there is a button "Copy the example"

    Scenario: An organization with projects is not shown the example
      When they open the "Configuration" tab of "Acme"
      Then they do not see "The file declares no projects yet."

  Rule: The tab says how to apply the file to this server

    Background:
      Given Ada is signed in to the dashboard
      And Ada owns an organization "Acme"

    Scenario: The commands carry this server's address
      When they open the "Configuration" tab of "Acme"
      Then the instructions name this server as the one to apply the file to
      And they see "npx mockingbird-fleet plan"
      And they see "npx mockingbird-fleet apply"
      And there is a button "Copy the plan and apply commands"

    Scenario: Deleting is said to need --prune
      When they open the "Configuration" tab of "Acme"
      Then they see "What the file no longer declares is deleted, with its stored state, only when you add --prune."

    Scenario: The API is offered for those without the CLI
      When they open the "Configuration" tab of "Acme"
      Then they see "No CLI is needed: the API takes the file as it is."
      And they see "--data-binary @mockingbird.yaml"
      And there is a button "Copy the curl command"

    Scenario: The same file is said to run the fleet locally
      When they open the "Configuration" tab of "Acme"
      Then they see "The same file starts these emulators on your machine."
      And they see "npx mockingbird-fleet serve --config mockingbird.yaml"

    Scenario: The credential to apply with is a link away
      When they open the "Configuration" tab of "Acme"
      And they follow "personal token"
      Then they see the page "Account"

    Scenario Outline: A <role> is offered <a> link to the organization's API keys
      Given Grace has joined "Acme" with the <role> role
      And Grace is signed in to the dashboard
      When they open the "Configuration" tab of "Acme"
      Then they see "of an admin, or an admin API key."
      And there is <a> link "API key"

      Examples:
        | role   | a  |
        | viewer | no |
        | member | no |
        | admin  | a  |
        | owner  | a  |

  Rule: A managed organization shows the file that was applied, who applied it and when

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
      And Ada is signed in to the dashboard

    Scenario: The tab says the file controls the organization, and who applied it when
      When they open the "Configuration" tab of "Acme"
      Then the setting "Controlled by" reads "mockingbird.yaml"
      And the configuration was last applied by Ada
      And they see "Its projects, fleets and emulators are read-only in the dashboard and the API, and change when the file is applied."
      And the screen keeps the design rules

    Scenario: The file on screen is the one that was applied, local-only services included
      When they open the "Configuration" tab of "Acme"
      Then the file on screen is the mockingbird.yaml that was applied
      And they see "local: true"

    Scenario: A file applied by a pipeline names the API key that applied it
      Given Ada has an organization key "ci" for "Acme" with the admin role
      And the key "ci" has applied it
      When they open the "Configuration" tab of "Acme"
      Then the configuration was last applied by the key "ci"

    Scenario: A managed organization is told how to apply the file to this server too
      When they open the "Configuration" tab of "Acme"
      Then the instructions name this server as the one to apply the file to

    Scenario Outline: A <role> reads the file and is offered <a> link to release the organization
      Given Grace has joined "Acme" with the <role> role
      And Grace is signed in to the dashboard
      When they open the organization "Acme"
      And they follow "Configuration"
      Then the setting "Controlled by" reads "mockingbird.yaml"
      And the configuration was last applied by Ada
      And the file on screen is the mockingbird.yaml that was applied
      And there is <a> link "Release the organization from mockingbird.yaml"

      Examples:
        | role   | a  |
        | viewer | no |
        | member | no |
        | admin  | a  |
        | owner  | a  |

  Rule: An admin releases an organization from its file on a screen of its own

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
                services:
                  resend: { durability: strict }
        """
      And Ada is signed in to the dashboard

    Scenario: The form says that nothing is deleted
      When they open the "Configuration" tab of "Acme"
      And they follow "Release the organization from mockingbird.yaml"
      Then they see the page "Release Acme from mockingbird.yaml"
      And the screen is the "org.configuration.release" form
      And the breadcrumb reads "Organizations, Acme, Configuration, Release"
      And they see "Nothing is deleted: every project, fleet and emulator stays as it is, with its stored state."
      And they see "The next apply of a mockingbird.yaml for this organization takes control back."
      And the configuration was last applied by Ada
      And the screen keeps the design rules

    Scenario: Cancel returns to the tab and the file stays in control
      When they open the "Configuration" tab of "Acme"
      And they follow "Release the organization from mockingbird.yaml"
      And they cancel
      Then the address is that of the "Configuration" tab of "Acme"
      And the setting "Controlled by" reads "mockingbird.yaml"
      And no note is shown
      And the organization "Acme" is managed by the file Ada applied

    Scenario: Releasing lands on the tab, which notes it and says the organization is configured by hand
      When they open the "Configuration" tab of "Acme"
      And they follow "Release the organization from mockingbird.yaml"
      And they press "Release organization"
      Then the address is that of the "Configuration" tab of "Acme"
      And the setting "Controlled by" is noted "Released just now"
      And the setting "Controlled by" reads "Configured by hand"
      And no time of applying is shown
      And there is no link "Release the organization from mockingbird.yaml"
      And the organization "Acme" is configured by hand
      And the screen keeps the design rules

    Scenario: Releasing deletes nothing
      Given 1 email has been sent through the "resend" emulator of "Staging"
      When they open the address of the organization "Acme" followed by "/configuration/release"
      And they press "Release organization"
      And they open the fleet "Staging"
      Then there is an emulator "resend"
      And the email that was sent is still in the "resend" emulator of "Staging"

    Scenario: After a release the controls to change things by hand return
      When they open the address of the organization "Acme" followed by "/configuration/release"
      And they press "Release organization"
      And they open the fleet "Staging"
      Then the screen does not say it is configured by mockingbird.yaml
      And there is a link "Rename the fleet"
      And there is a link "Add an emulator"
      And there is a link "Remove resend"

    Scenario: After a release the file shown is generated from what Fleet Cloud runs
      When they open the address of the organization "Acme" followed by "/configuration/release"
      And they press "Release organization"
      Then the file on screen is:
        """
        version: 1
        organization: <Acme>
        name: Acme
        projects:
          web:
            name: Web app
            fleets:
              <Staging>:
                name: Staging
                access: open
                services:
                  resend: { durability: strict }
        """

    Scenario Outline: A <role> who opens the address for releasing has no access
      Given Grace has joined "Acme" with the <role> role
      And Grace is signed in to the dashboard
      When they open the address of the organization "Acme" followed by "/configuration/release"
      Then they are told they have no access
      And they see "Releasing the organization is for admins and above of Acme. You are a <role>."

      Examples:
        | role   |
        | viewer |
        | member |

    Scenario: An admin releases the organization as an owner can
      Given Grace has joined "Acme" with the admin role
      And Grace is signed in to the dashboard
      When they open the "Configuration" tab of "Acme"
      And they follow "Release the organization from mockingbird.yaml"
      And they press "Release organization"
      Then the setting "Controlled by" is noted "Released just now"

    Scenario: The address for releasing an organization that has no file opens the Configuration tab
      Given Ada has released the organization "Acme" from its file
      When they open the address of the organization "Acme" followed by "/configuration/release"
      Then the address is that of the "Configuration" tab of "Acme"
      And the setting "Controlled by" reads "Configured by hand"

  Rule: Where something can be created by hand, the dashboard points to the file first

    Background:
      Given Ada is signed in to the dashboard
      And Ada owns an organization "Acme"

    Scenario: An organization without projects leads to the Configuration tab
      When they open the organization "Acme"
      Then they see "Declare this organization's projects, fleets and emulators in mockingbird.yaml and apply it."
      And the main action offered is "Start from mockingbird.yaml"
      And there is a link "New project"
      When they follow "Start from mockingbird.yaml"
      Then the "Configuration" tab is the current one
      And the address is that of the "Configuration" tab of "Acme"

    Scenario: A project without fleets leads to the Configuration tab
      Given Ada has a project "Web app" in "Acme"
      When they open the project "Web app"
      Then they see "Declare this project's fleets and their emulators in mockingbird.yaml and apply it."
      And the main action offered is "Start from mockingbird.yaml"
      And there is a link "New fleet"
      When they follow "Start from mockingbird.yaml"
      Then the address is that of the "Configuration" tab of "Acme"

    Scenario: A fleet without emulators leads to the Configuration tab
      Given Ada has a project "Web app" in "Acme"
      And Ada has a fleet "Staging" in the project "Web app"
      When they open the fleet "Staging"
      Then they see "Declare this fleet's emulators in mockingbird.yaml and apply it."
      And the main action offered is "Start from mockingbird.yaml"
      And there is a link "Add an emulator"
      When they follow "Start from mockingbird.yaml"
      Then the address is that of the "Configuration" tab of "Acme"

    Scenario: Once an organization has a project, creating another is the main action
      Given Ada has a project "Web app" in "Acme"
      When they open the organization "Acme"
      Then the main action offered is "New project"
      And they do not see "Start from mockingbird.yaml"

    Scenario Outline: The form for creating <what> by hand recommends the file instead
      Given Ada has a project "Web app" in "Acme"
      And Ada has a fleet "Staging" in the project "Web app"
      When they open the address of the <kind> "<name>" followed by "<rest>"
      Then the screen is the "<form>" form
      And the form recommends mockingbird.yaml for "<what>"
      And the screen keeps the design rules
      When they follow "Use mockingbird.yaml instead"
      Then the address is that of the "Configuration" tab of "Acme"

      Examples:
        | what                       | kind         | name    | rest                 | form                   |
        | the project                | organization | Acme    | /projects/new        | project.new            |
        | the fleet and its emulators | project     | Web app | /fleets/new          | fleet.new              |
        | the emulator               | fleet        | Staging | /add-emulator/stripe | emulator.add.configure |

    Scenario: The list of emulators to add recommends the file instead
      Given Ada has a project "Web app" in "Acme"
      And Ada has a fleet "Staging" in the project "Web app"
      When they open the address of the fleet "Staging" followed by "/add-emulator"
      Then they see "Prefer mockingbird.yaml: declare the emulator in the file and apply it"
      And there is a link "Use mockingbird.yaml instead"

    Scenario: A viewer of an empty organization is not sent to the file
      Given Grace has joined "Acme" with the viewer role
      And Grace is signed in to the dashboard
      When they open the organization "Acme"
      Then they see "A member of the organization can create one."
      And there is no link "Start from mockingbird.yaml"
