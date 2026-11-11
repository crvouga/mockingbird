@dashboard
Feature: Organizations in the dashboard
  Everything a person hosts belongs to an organization. The dashboard lists the ones they belong
  to and opens one to work in it. A new organization is made on a screen of its own, which lands
  on the new organization with a note that it was just created.

  Background:
    Given Ada is signed in to the dashboard

  Scenario: Someone with no organization is told how to start
    When they open the dashboard
    Then they see the page "Organizations"
    And they see "You are not in any organization yet"
    And they see "Create one to start hosting fleets, or open an invite link to join one."
    And there is a link "New organization"

  Scenario: Creating an organization opens it, noting that it was just created
    When they open the dashboard
    And they follow "New organization"
    Then they see the page "New organization"
    And the screen is the "org.new" form
    When they type "Acme" into "Name"
    And they press "Create organization"
    Then they see the page "Acme"
    And they see the note "Created just now"
    And they see "You are an owner of this organization."
    And they see "No projects yet"
    When they reload the page
    Then they see the page "Acme"
    And no note is shown

  Scenario: Cancel returns to the list and creates nothing
    When they open the dashboard
    And they follow "New organization"
    And they type "Acme" into "Name"
    And they cancel
    Then they see the page "Organizations"
    And they see "You are not in any organization yet"
    And the address is "/orgs"

  Scenario: An empty name is pointed out under the field and nothing is created
    When they open the dashboard at "/orgs/new"
    And they type "   " into "Name"
    And they press "Create organization"
    Then the field "Name" says "Enter a name for the organization."
    And exactly 1 problem is pointed out
    And they see the page "New organization"
    When they cancel
    Then they see "You are not in any organization yet"

  Scenario: The list names each organization and the person's role in it
    Given Ada owns an organization "Acme"
    And Grace owns an organization "Globex"
    And Ada has joined "Globex" with the viewer role
    When they open the dashboard at "/orgs"
    Then the organization "Acme" is listed with the role "owner"
    And the organization "Globex" is listed with the role "viewer"

  Scenario: The bare address opens the first organization
    Given Ada owns an organization "Acme"
    When they open the dashboard
    Then they see the page "Acme"
    And the address is that of the organization "Acme"

  Scenario: Switching to another organization
    Given Ada owns an organization "Acme"
    And Ada owns an organization "Initech"
    When they open the organization "Acme"
    And they follow "Organizations"
    And they follow the organization "Initech"
    Then they see the page "Initech"
    And the address is that of the organization "Initech"

  Rule: A suspended organization says so on every tab

    Background:
      Given Ada owns an organization "Acme"
      And the operator has suspended "Acme" for "unpaid invoice"

    Scenario Outline: The suspension is announced on the <tab> tab
      When they open the "<tab>" tab of "Acme"
      Then they see "This organization is suspended: unpaid invoice."
      And they see "Its fleets do not serve requests, and nothing can be created or changed until the operator of this server lifts the suspension."

      Examples:
        | tab       |
        | Projects  |
        | Members   |
        | Usage     |
        | API keys  |
        | Audit log |
        | Settings  |

    Scenario: A refused change is explained in the form that made it
      When they open the organization "Acme"
      And they follow "New project"
      And they type "Checkout" into "Name"
      And they press "Create project"
      Then the form says "The project was not created."
      And the form says "This organization is suspended: unpaid invoice. Contact the operator of this service."
      And no field is marked wrong
      And exactly 1 problem is pointed out
      And they see the page "New project"
