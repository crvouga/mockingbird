@dashboard
Feature: Organizations in the dashboard
  Everything a person hosts belongs to an organization. The dashboard lists the ones they belong
  to, lets them create more, and opens one to work in it.

  Background:
    Given Ada is signed in to the dashboard

  Scenario: Someone with no organization is told how to start
    When they open the dashboard
    Then they see the page "Organizations"
    And they see "No organizations yet"
    And they see "Create one to start hosting fleets, or open an invite link to join one."

  Scenario: Creating an organization opens it
    When they open the dashboard
    And they type "Acme" into "Organization name"
    And they press "Create organization"
    Then they see the page "Acme"
    And they see "You are an owner of this organization."
    And they see "No projects yet"

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

  Scenario: A name the server refuses is explained and nothing is created
    When they open the dashboard at "/orgs"
    And they type "   " into "Organization name"
    And they press "Create organization"
    Then they see the error "name"
    And they see the page "Organizations"
    And they see "No organizations yet"

  Rule: A suspended organization says so on every tab

    Background:
      Given Ada owns an organization "Acme"
      And the operator has suspended "Acme" for "unpaid invoice"

    Scenario Outline: The suspension is announced on the <tab> tab
      When they open the "<tab>" tab of "Acme"
      Then they see the error "This organization is suspended: unpaid invoice. Its fleets do not serve requests and nothing can be created or changed."

      Examples:
        | tab       |
        | Projects  |
        | Members   |
        | Usage     |
        | API keys  |
        | Audit log |
        | Settings  |

    Scenario: A refused change is explained without hiding the suspension
      When they open the organization "Acme"
      And they type "Checkout" into "Project name"
      And they press "Create project"
      Then they see the error "This organization is suspended: unpaid invoice. Contact the operator of this service."
      And they see the error "Its fleets do not serve requests and nothing can be created or changed."
      And exactly 2 errors are shown
