@dashboard
Feature: Getting around the dashboard
  Every screen has an address of its own, so a link to it can be shared, the browser's back and
  forward buttons work, and an address that names nothing says so. Every change has an address
  too; once it is made, the dashboard replaces that address with the screen the result lives on,
  so going back never returns to a form that was already sent.

  Background:
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"
    And Ada has a project "Web app" in "Acme"
    And Ada has a fleet "Staging" in the project "Web app"

  Rule: Every screen has an address

    Scenario Outline: The address of the <tab> tab opens that tab
      When they open the "<tab>" tab of "Acme"
      Then they see the page "Acme"
      And the "<tab>" tab is the current one
      And they see "<shown>"

      Examples:
        | tab       | shown                                      |
        | Projects  | Web app                                    |
        | Members   | Pending invites                            |
        | Usage     | Requests per day                           |
        | API keys  | No API keys yet                            |
        | Audit log | The 200 most recent changes, newest first. |
        | Settings  | Delete this organization                   |

    Scenario Outline: The address <address> opens <page>
      When they open the dashboard at "<address>"
      Then they see the page "<page>"

      Examples:
        | address             | page               |
        | /orgs               | Organizations      |
        | /orgs/new           | New organization   |
        | /account            | Account            |
        | /account/tokens/new | New personal token |
        | /api-reference      | API reference      |

    Scenario Outline: The address of a <kind> followed by "<rest>" opens "<page>"
      When they open the address of the <kind> "<name>" followed by "<rest>"
      Then they see the page "<page>"

      Examples:
        | kind         | name    | rest                 | page                                      |
        | project      | Web app |                      | Web app                                   |
        | project      | Web app | /rename              | Rename Web app                            |
        | project      | Web app | /fleets/new          | New fleet                                 |
        | fleet        | Staging |                      | Staging                                   |
        | fleet        | Staging | /rate-limit          | Change the requests per minute of Staging |
        | fleet        | Staging | /add-emulator        | Add an emulator to Staging                |
        | fleet        | Staging | /add-emulator/stripe | Add Stripe to Staging                     |
        | organization | Acme    | /projects/new        | New project                               |
        | organization | Acme    | /invites/new         | Invite someone to Acme                    |

    Scenario: Following a tab changes the address
      When they open the organization "Acme"
      And they follow "API keys"
      Then the "API keys" tab is the current one
      And the address is that of the "API keys" tab of "Acme"

    Scenario: The brand leads to the list of organizations
      When they open the fleet "Staging"
      And they follow "Mockingbird Fleet"
      Then they see the page "Organizations"
      And the address is "/orgs"

    Scenario: The breadcrumb leads to every level above a screen
      When they open the address of the fleet "Staging" followed by "/rename"
      Then the breadcrumb reads "Organizations, Acme, Web app, Staging, Rename"
      When they follow "Web app"
      Then they see the page "Web app"
      And the breadcrumb reads "Organizations, Acme, Web app"

  Rule: The browser's back and forward buttons retrace the screens visited

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
      And they follow "Rename the fleet"
      And they cancel
      And they go back
      Then the page was loaded only once

    Scenario: Back after a change does not return to the form that made it
      When they open the project "Web app"
      And they follow "Rename the project"
      And they type "Storefront" into "Name"
      And they press "Rename project"
      Then they see the note "Renamed just now"
      When they go back
      Then they see the page "Storefront"
      And no note is shown
      And the address is that of the project "Web app"

    Scenario: A form revisited with back shows none of what was typed or pointed out before
      When they open the project "Web app"
      And they follow "Rename the project"
      And they clear "Name"
      And they press "Rename project"
      Then the field "Name" says "Enter a name for the project."
      When they cancel
      And they go back
      Then they see the page "Rename Web app"
      And no problem is pointed out
      And the field "Name" holds "Web app"

    Scenario: A note does not come back when the screen is revisited
      When they open the project "Web app"
      And they follow "Rename the project"
      And they type "Storefront" into "Name"
      And they press "Rename project"
      And they follow "Acme"
      And they go back
      Then they see the page "Storefront"
      And no note is shown

  Rule: An address that names nothing says so

    Scenario Outline: An address for <what> that does not exist shows "Not found"
      When they open the dashboard at "<address>"
      Then they are told it was not found
      And they see "<message>"
      And there is a link "Go to your organizations"

      Examples:
        | what            | address                   | message                |
        | an organization | /orgs/org_nope            | Organization not found |
        | a project       | /projects/prj_nope        | Project not found      |
        | a fleet         | /fleets/flt_nope          | Fleet not found        |
        | a change        | /fleets/flt_nope/rename   | Fleet not found        |

    Scenario: Someone else's organization is not found either
      Given Grace owns an organization "Globex"
      When they open the organization "Globex"
      Then they are told it was not found
      And they do not see "Globex"

    Scenario Outline: An address the dashboard does not know says so: <address>
      When they open the dashboard at "<address>"
      Then they are told the page does not exist
      And they see "Nothing lives at <address>."
      When they follow "Go to your organizations"
      Then they see the page "Organizations"

      Examples:
        | address                       |
        | /no-such-page                 |
        | /orgs/org_nope/nonsense       |
        | /fleets/flt_nope/emulators/x  |

    Scenario: A visitor at an unknown address is offered sign-in
      Given a visitor who is not signed in
      When they open the dashboard at "/no-such-page"
      Then they are told the page does not exist
      When they follow "Go to sign-in"
      Then they are asked to sign in
