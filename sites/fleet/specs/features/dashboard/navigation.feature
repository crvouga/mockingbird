@dashboard
Feature: Getting around the dashboard
  Every screen has an address of its own, so a link to it can be shared, the browser's back and
  forward buttons work, and an address that names nothing says so.

  Background:
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"
    And Ada has a project "Web app" in "Acme"
    And Ada has a fleet "Staging" in the project "Web app"

  Scenario Outline: The address of the <tab> tab opens that tab
    When they open the "<tab>" tab of "Acme"
    Then they see the page "Acme"
    And the "<tab>" tab is the current one
    And they see "<shown>"

    Examples:
      | tab       | shown                                                    |
      | Projects  | Web app                                                  |
      | Members   | Invite someone                                           |
      | Usage     | Requests per day                                         |
      | API keys  | No API keys yet.                                         |
      | Audit log | The 200 most recent changes, newest first.               |
      | Settings  | Delete organization                                      |

  Scenario Outline: The address <address> opens <page>
    When they open the dashboard at "<address>"
    Then they see the page "<page>"

    Examples:
      | address        | page          |
      | /orgs          | Organizations |
      | /account       | Account       |
      | /api-reference | API reference |

  Scenario: The address of a project opens it
    When they open the project "Web app"
    Then they see the page "Web app"
    And they see "Staging"

  Scenario: The address of a fleet opens it
    When they open the fleet "Staging"
    Then they see the page "Staging"

  Scenario: Clicking a tab changes the address
    When they open the organization "Acme"
    And they follow "API keys"
    Then the "API keys" tab is the current one
    And the address is that of the "API keys" tab of "Acme"

  Scenario: An address with an unknown tab shows the projects
    When they open the dashboard at the organization "Acme" followed by "/nonsense"
    Then the "Projects" tab is the current one
    And they see "Web app"

  Scenario: The brand leads to the list of organizations
    When they open the fleet "Staging"
    And they follow "Mockingbird Fleet"
    Then they see the page "Organizations"
    And the address is "/orgs"

  Scenario: Back and forward retrace the screens visited
    When they open the organization "Acme"
    And they follow the project "Web app"
    And they follow the fleet "Staging"
    Then they see the page "Staging"
    When they go back
    Then they see the page "Web app"
    And the address is that of the project "Web app"
    When they go back
    Then they see the page "Acme"
    When they go forward
    Then they see the page "Web app"
    When they go forward
    Then they see the page "Staging"
    And the address is that of the fleet "Staging"

  Scenario: Moving between screens does not reload the page
    When they open the organization "Acme"
    And they follow the project "Web app"
    And they follow the fleet "Staging"
    And they go back
    Then the page was loaded only once

  Rule: An address that names nothing says so

    Scenario Outline: An address for <what> that does not exist shows "Not found"
      When they open the dashboard at "<address>"
      Then they see "Not found"
      And they see "<message>"
      And there is a link "Account"

      Examples:
        | what            | address              | message                |
        | an organization | /orgs/org_nope       | Organization not found |
        | a project       | /projects/prj_nope   | Project not found      |
        | a fleet         | /fleets/flt_nope     | Fleet not found        |

    Scenario: Someone else's organization is not found either
      Given Grace owns an organization "Globex"
      When they open the organization "Globex"
      Then they see "Not found"
      And they do not see "Globex"

    Scenario: An address the dashboard does not know shows the list of organizations
      When they open the dashboard at "/no-such-page"
      Then they see the page "Organizations"
