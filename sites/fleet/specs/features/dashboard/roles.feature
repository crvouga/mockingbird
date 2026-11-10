@dashboard
Feature: What each role is offered in the dashboard
  The dashboard offers a person only what the API will let their role do: a viewer reads, a
  member builds, an admin administers, an owner owns. A control the API would refuse is absent or
  disabled, and a page a role may not see says so plainly.

  Background:
    Given Ada owns an organization "Acme"
    And Ada has a project "Web app" in "Acme"
    And Ada has a fleet "Staging" in the project "Web app" running:
      | name   | emulator | durability |
      | resend | resend   | buffered   |
    And Linus has joined "Acme" with the member role

  Rule: An organization shows the tabs a role may open

    Scenario Outline: A <role> sees the tabs <tabs>
      Given Grace has joined "Acme" with the <role> role
      And Grace is signed in to the dashboard
      When they open the organization "Acme"
      Then they see "You are <article> <role> of this organization."
      And the organization's tabs are "<tabs>"

      Examples:
        | role   | article | tabs                                                    |
        | viewer | a       | Projects, Members, Usage                                |
        | member | a       | Projects, Members, Usage                                |
        | admin  | an      | Projects, Members, Usage, API keys, Audit log, Settings |
        | owner  | an      | Projects, Members, Usage, API keys, Audit log, Settings |

    Scenario Outline: A <role> who opens the address of the <tab> tab is told they have no access
      Given Grace has joined "Acme" with the <role> role
      And Grace is signed in to the dashboard
      When they open the "<tab>" tab of "Acme"
      Then they see "You do not have access"
      And they see "<tab> is for admins and owners of this organization. You are a <role>."
      And they do not see "Something went wrong"
      And they see the page "Acme"

      Examples:
        | role   | tab       |
        | viewer | API keys  |
        | viewer | Audit log |
        | viewer | Settings  |
        | member | API keys  |
        | member | Audit log |
        | member | Settings  |

    Scenario Outline: A <role> who opens the address of the <tab> tab sees it
      Given Grace has joined "Acme" with the <role> role
      And Grace is signed in to the dashboard
      When they open the "<tab>" tab of "Acme"
      Then the "<tab>" tab is the current one
      And they do not see "You do not have access"

      Examples:
        | role  | tab       |
        | admin | API keys  |
        | admin | Audit log |
        | admin | Settings  |
        | owner | API keys  |
        | owner | Audit log |
        | owner | Settings  |

  Rule: Creating projects needs a member

    Scenario Outline: A <role> is offered <a> way to create a project
      Given Grace has joined "Acme" with the <role> role
      And Grace is signed in to the dashboard
      When they open the organization "Acme"
      Then they see "Web app"
      And there is <a> button "Create project"

      Examples:
        | role   | a  |
        | viewer | no |
        | member | a  |
        | admin  | a  |
        | owner  | a  |

  Rule: Managing members needs an admin, and owners answer only to owners

    Scenario Outline: A <role> can see the members and leave, and nothing else
      Given Grace has joined "Acme" with the <role> role
      And Grace is signed in to the dashboard
      When they open the "Members" tab of "Acme"
      Then the role of Ada is "owner"
      And the role of Linus is "member"
      And nobody's role can be changed
      And the only button among the members is "Leave"
      And they do not see "Invite someone"

      Examples:
        | role   |
        | viewer |
        | member |

    Scenario: An admin manages everyone but owners
      Given Grace has joined "Acme" with the admin role
      And Grace is signed in to the dashboard
      When they open the "Members" tab of "Acme"
      Then the role of Linus can be changed to "viewer, member, admin"
      And the role of Ada cannot be changed
      And Ada cannot be removed
      And Linus can be removed
      And they see "Invite someone"

    Scenario: An owner manages everyone, owners included
      Given Grace has joined "Acme" with the owner role
      And Grace is signed in to the dashboard
      When they open the "Members" tab of "Acme"
      Then the role of Linus can be changed to "viewer, member, admin, owner"
      And the role of Ada can be changed to "viewer, member, admin, owner"
      And Ada can be removed
      And they see "Invite someone"

  Rule: Creating fleets needs a member; deleting a project needs an admin

    Scenario Outline: On a project, a <role> is offered <create> way to create a fleet and <delete> way to delete the project
      Given Grace has joined "Acme" with the <role> role
      And Grace is signed in to the dashboard
      When they open the project "Web app"
      Then they see "Staging"
      And there is <create> button "Create fleet"
      And there is <delete> button "Delete project"

      Examples:
        | role   | create | delete |
        | viewer | no     | no     |
        | member | a      | no     |
        | admin  | a      | a      |
        | owner  | a      | a      |

    Scenario: A viewer is told why a project offers nothing to change
      Given Grace has joined "Acme" with the viewer role
      And Grace is signed in to the dashboard
      When they open the project "Web app"
      Then they see "You are a viewer: you can look at fleets, not change them."

  Rule: Changing a fleet needs a member

    Scenario Outline: On a fleet, a <role> is offered <a> way to <change>
      Given Grace has joined "Acme" with the <role> role
      And Grace is signed in to the dashboard
      When they open the fleet "Staging"
      Then there is an emulator "resend"
      And there is <a> button "<button>"

      Examples:
        | role   | a  | change               | button         |
        | viewer | no | delete the fleet     | Delete fleet   |
        | viewer | no | set its rate limit   | Set rate limit |
        | viewer | no | save an emulator     | Save now       |
        | viewer | no | download state       | Download state |
        | viewer | no | reset an emulator    | Reset state    |
        | viewer | no | remove an emulator   | Remove         |
        | member | a  | delete the fleet     | Delete fleet   |
        | member | a  | set its rate limit   | Set rate limit |
        | member | a  | save an emulator     | Save now       |
        | member | a  | download state       | Download state |
        | member | a  | reset an emulator    | Reset state    |
        | member | a  | remove an emulator   | Remove         |
        | admin  | a  | delete the fleet     | Delete fleet   |
        | admin  | a  | remove an emulator   | Remove         |
        | owner  | a  | delete the fleet     | Delete fleet   |
        | owner  | a  | remove an emulator   | Remove         |

    Scenario: A viewer sees a fleet's addresses and settings but cannot change them
      Given Grace has joined "Acme" with the viewer role
      And Grace is signed in to the dashboard
      When they open the fleet "Staging"
      Then they see "You are a viewer: you can look at this fleet, not change it."
      And the address of the fleet "Staging" is on screen with a "Copy fleet URL" button
      And the address of the "resend" emulator of "Staging" is on its card with a "Copy URL" button
      And "Buffered" is the durability of "resend"
      And the durability of "resend" cannot be switched
      And who can call the fleet cannot be changed
      And the requests per minute cannot be changed
      And they do not see "Add an emulator"

    Scenario Outline: A <role> can change everything about a fleet
      Given Grace has joined "Acme" with the <role> role
      And Grace is signed in to the dashboard
      When they open the fleet "Staging"
      And they switch the durability of "resend" to "Strict"
      And they choose "Only requests with an API key (x-mockingbird-api-key)" as the "Who can call this fleet"
      And they type "stripe" into "Search emulators"
      And they add "Stripe" from the catalog
      Then "Strict" is the durability of "resend"
      And there is an emulator "stripe"
      And no error is shown

      Examples:
        | role   |
        | member |
        | admin  |
