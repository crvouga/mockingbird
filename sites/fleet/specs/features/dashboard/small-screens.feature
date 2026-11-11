@dashboard
Feature: The dashboard on a small screen
  On a phone 390 points wide every screen fits: nothing has to be scrolled sideways, and the
  details of a row wrap instead of being cut off. That holds for the screens that show things,
  the screens that change them, and the screens that show a secret once.

  Scenario: The sign-in screen fits a phone
    Given a visitor on a phone who is not signed in
    When they open the dashboard
    Then they are asked to sign in
    And nothing reaches past the edge of the screen

  Scenario: A sign-in form fits a phone
    Given a visitor on a phone who is not signed in
    When they open the dashboard at "/sign-in/local"
    And they press "Sign in"
    Then the field "Email" says "Enter an email address."
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

    Scenario Outline: The <screen> fits a phone
      When they open the <screen>
      Then they see the page "<page>"
      And nothing reaches past the edge of the screen

      Examples:
        | screen                                                                 | page                                      |
        | dashboard at "/orgs"                                                   | Organizations                             |
        | project "Web application for customers"                               | Web application for customers             |
        | fleet "Staging"                                                        | Staging                                   |
        | dashboard at "/account"                                                | Account                                   |
        | dashboard at "/api-reference"                                          | API reference                             |
        | address of the fleet "Staging" followed by "/add-emulator"             | Add an emulator to Staging                |
        | address of the fleet "Staging" followed by "/add-emulator/stripe"      | Add Stripe to Staging                     |
        | address of the fleet "Staging" followed by "/emulators/resend/durability" | Change the durability of resend        |
        | address of the fleet "Staging" followed by "/access"                   | Change who can call Staging               |
        | address of the fleet "Staging" followed by "/delete"                   | Delete Staging                            |
        | address of the organization "Acme Research and Development" followed by "/delete" | Delete Acme Research and Development |

    Scenario: A form with problems pointed out fits a phone
      When they open the "API keys" tab of "Acme Research and Development"
      And they follow "New API key"
      And they choose "Project: Web application for customers" as the "Scope"
      And they choose "Admin" as the "Role"
      And they press "Create API key"
      Then the field "Name" says "Enter a name for the key."
      And the field "Role" says "A project key is at most a member."
      And nothing reaches past the edge of the screen

    Scenario: A key's details wrap instead of being cut off
      When they open the "API keys" tab of "Acme Research and Development"
      Then the key "continuous integration for the web app" says "Last used never"
      And the details of the key "continuous integration for the web app" are shown in full

    Scenario: A secret that was just created fits a phone
      When they open the "API keys" tab of "Acme Research and Development"
      And they follow "New API key"
      And they type "deploy" into "Name"
      And they press "Create API key"
      Then a secret starting with "mbf_o_" is shown
      And nothing reaches past the edge of the screen
