@dashboard
Feature: The dashboard on a small screen
  On a phone 390 points wide every screen fits: nothing has to be scrolled sideways, and the
  details of a row wrap instead of being cut off.

  Scenario: The sign-in screen fits a phone
    Given a visitor on a phone who is not signed in
    When they open the dashboard
    Then they are asked to sign in
    And nothing reaches past the edge of the screen

  Rule: Every screen of a busy organization fits

    Background:
      Given Ada is signed in to the dashboard on a phone
      And Ada owns an organization "Acme Research and Development"
      And Ada has a project "Web application for customers" in "Acme Research and Development"
      And Ada has a fleet "Staging" in the project "Web application for customers" running:
        | name     | emulator | durability |
        | resend   | resend   | buffered   |
        | stripe   | stripe   | strict     |
        | stripe-2 | stripe   | ephemeral  |
      And Grace has joined "Acme Research and Development" with the admin role
      And Ada has invited Linus to "Acme Research and Development" as a viewer
      And Ada has an organization key "continuous integration for the web app" for "Acme Research and Development" with the member role
      And 2 emails have been sent through the "resend" emulator of "Staging"

    Scenario Outline: The <tab> tab fits a phone
      When they open the "<tab>" tab of "Acme Research and Development"
      Then the "<tab>" tab is the current one
      And nothing reaches past the edge of the screen

      Examples:
        | tab       |
        | Projects  |
        | Members   |
        | Usage     |
        | API keys  |
        | Audit log |
        | Settings  |

    Scenario: The list of organizations fits a phone
      When they open the dashboard at "/orgs"
      Then they see the page "Organizations"
      And nothing reaches past the edge of the screen

    Scenario: A project fits a phone
      When they open the project "Web application for customers"
      Then they see the page "Web application for customers"
      And nothing reaches past the edge of the screen

    Scenario: A fleet fits a phone
      When they open the fleet "Staging"
      Then there is an emulator "stripe-2"
      And nothing reaches past the edge of the screen

    Scenario: A fleet with the catalog open fits a phone
      When they open the fleet "Staging"
      And they put the cursor in "Search emulators"
      Then the search offers "Airtable"
      And nothing reaches past the edge of the screen

    Scenario: The account page fits a phone
      Given Ada has a personal token "laptop"
      When they open the dashboard at "/account"
      Then the token "laptop" is listed
      And nothing reaches past the edge of the screen

    Scenario: The API reference fits a phone
      When they open the dashboard at "/api-reference"
      Then they see the page "API reference"
      And nothing reaches past the edge of the screen

    Scenario: A key's details wrap instead of being cut off
      When they open the "API keys" tab of "Acme Research and Development"
      Then the key "continuous integration for the web app" says "last used never"
      And the details of the key "continuous integration for the web app" are shown in full

    Scenario: A secret that was just created fits a phone
      When they open the "API keys" tab of "Acme Research and Development"
      And they type "deploy" into "Key name"
      And they press "Create key"
      Then a secret starting with "mbf_o_" is shown
      And nothing reaches past the edge of the screen
