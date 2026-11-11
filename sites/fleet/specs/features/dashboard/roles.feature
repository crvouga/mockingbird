@dashboard
Feature: What each role is offered in the dashboard
  The dashboard offers a person only what the API will let their role do: a viewer reads, a
  member builds, an admin administers, an owner owns. Every change is a screen of its own, so
  what a role may do shows as the links it is offered; a link the API would refuse is absent.
  Opening the address of a screen the role may not use says so plainly instead of a form.

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
      Then they are told they have no access
      And they see "<tab> is for admins and owners of Acme. You are a <role>."
      And there is a link "Go to your organizations"

      Examples:
        | role   | tab       |
        | viewer | API keys  |
        | viewer | Audit log |
        | viewer | Settings  |
        | member | API keys  |
        | member | Audit log |
        | member | Settings  |

  Rule: Each screen offers a role the links to the changes it may make

    Scenario Outline: On the organization, a <role> is offered <a> link "<link>"
      Given Grace has joined "Acme" with the <role> role
      And Grace is signed in to the dashboard
      When they open the "<tab>" tab of "Acme"
      Then there is <a> link "<link>"

      Examples:
        | role   | tab      | link                    | a  |
        | viewer | Projects | New project             | no |
        | member | Projects | New project             | a  |
        | admin  | Projects | New project             | a  |
        | owner  | Projects | New project             | a  |
        | viewer | Members  | Invite someone          | no |
        | member | Members  | Invite someone          | no |
        | admin  | Members  | Invite someone          | a  |
        | owner  | Members  | Invite someone          | a  |
        | admin  | API keys | New API key             | a  |
        | admin  | Settings | Rename the organization | a  |
        | admin  | Settings | Delete organization…    | no |
        | owner  | Settings | Rename the organization | a  |
        | owner  | Settings | Delete organization…    | a  |

    Scenario Outline: On a project, a <role> is offered <a> link "<link>"
      Given Grace has joined "Acme" with the <role> role
      And Grace is signed in to the dashboard
      When they open the project "Web app"
      Then they see "Staging"
      And there is <a> link "<link>"

      Examples:
        | role   | link               | a  |
        | viewer | New fleet          | no |
        | viewer | Rename the project | no |
        | viewer | Delete project…    | no |
        | member | New fleet          | a  |
        | member | Rename the project | a  |
        | member | Delete project…    | no |
        | admin  | New fleet          | a  |
        | admin  | Rename the project | a  |
        | admin  | Delete project…    | a  |
        | owner  | Delete project…    | a  |

    Scenario Outline: On a fleet, a <role> is offered <a> link "<link>"
      Given Grace has joined "Acme" with the <role> role
      And Grace is signed in to the dashboard
      When they open the fleet "Staging"
      Then there is an emulator "resend"
      And there is <a> link "<link>"

      Examples:
        | role   | link                             | a  |
        | viewer | Add an emulator                  | no |
        | viewer | Rename the fleet                 | no |
        | viewer | Change who can call the fleet    | no |
        | viewer | Change the requests per minute   | no |
        | viewer | Change the durability of resend  | no |
        | viewer | Save resend now                  | no |
        | viewer | Reset the state of resend        | no |
        | viewer | Remove resend                    | no |
        | viewer | Delete fleet…                    | no |
        | member | Add an emulator                  | a  |
        | member | Rename the fleet                 | a  |
        | member | Change who can call the fleet    | a  |
        | member | Change the requests per minute   | a  |
        | member | Change the durability of resend  | a  |
        | member | Save resend now                  | a  |
        | member | Reset the state of resend        | a  |
        | member | Remove resend                    | a  |
        | member | Delete fleet…                    | a  |
        | admin  | Delete fleet…                    | a  |
        | owner  | Delete fleet…                    | a  |

    Scenario: A viewer is told why a project offers nothing to change
      Given Grace has joined "Acme" with the viewer role
      And Grace is signed in to the dashboard
      When they open the project "Web app"
      Then they see "You are a viewer: you can look at this project and its fleets, not change them."

    Scenario: A viewer sees a fleet's addresses and settings, and may still download its state
      Given Grace has joined "Acme" with the viewer role
      And Grace is signed in to the dashboard
      When they open the fleet "Staging"
      Then they see "You are a viewer: you can look at this fleet and use its URLs, not change it."
      And the address of the fleet "Staging" is on screen with a "Copy URL" button
      And the address of the "resend" emulator of "Staging" is on its card with a "Copy URL" button
      And "Buffered" is the durability of "resend"
      And the setting "Who can call it" reads "Anyone with the URL"
      And there is a button "Download the state of resend"

  Rule: Managing members needs an admin, and owners answer only to owners

    Scenario Outline: A <role> sees the members and can leave, and nothing else
      Given Grace has joined "Acme" with the <role> role
      And Grace is signed in to the dashboard
      When they open the "Members" tab of "Acme"
      Then the role of Ada is "owner"
      And the role of Linus is "member"
      And nobody's role can be changed
      And the only link among the members is "Leave"
      And they do not see "Pending invites"

      Examples:
        | role   |
        | viewer |
        | member |

    Scenario: An admin manages everyone but owners
      Given Grace has joined "Acme" with the admin role
      And Grace is signed in to the dashboard
      When they open the "Members" tab of "Acme"
      Then the role of Linus can be changed
      And Linus can be removed
      And the role of Ada cannot be changed
      And Ada cannot be removed
      When they follow "Change role" beside Linus
      Then the choices for "Role" are "Viewer, Member, Admin"

    Scenario: An owner manages everyone, owners included
      Given Grace has joined "Acme" with the owner role
      And Grace is signed in to the dashboard
      When they open the "Members" tab of "Acme"
      Then the role of Ada can be changed
      And Ada can be removed
      When they follow "Change role" beside Linus
      Then the choices for "Role" are "Viewer, Member, Admin, Owner"

  Rule: The address of a change a role may not make says so instead of showing a form

    Scenario Outline: A <role> who opens <rest> of the <kind> "<name>" has no access
      Given Grace has joined "Acme" with the <role> role
      And Grace is signed in to the dashboard
      When they open the address of the <kind> "<name>" followed by "<rest>"
      Then they are told they have no access
      And they see "You are a <role>."

      Examples:
        | role   | kind         | name    | rest                         |
        | viewer | organization | Acme    | /projects/new                |
        | member | organization | Acme    | /rename                      |
        | member | organization | Acme    | /invites/new                 |
        | member | organization | Acme    | /keys/new                    |
        | viewer | project      | Web app | /rename                      |
        | viewer | project      | Web app | /fleets/new                  |
        | member | project      | Web app | /delete                      |
        | viewer | fleet        | Staging | /rename                      |
        | viewer | fleet        | Staging | /access                      |
        | viewer | fleet        | Staging | /rate-limit                  |
        | viewer | fleet        | Staging | /delete                      |
        | viewer | fleet        | Staging | /add-emulator                |
        | viewer | fleet        | Staging | /add-emulator/stripe         |
        | viewer | fleet        | Staging | /emulators/resend/durability |
        | viewer | fleet        | Staging | /emulators/resend/save       |
        | viewer | fleet        | Staging | /emulators/resend/reset      |
        | viewer | fleet        | Staging | /emulators/resend/remove     |

    Scenario Outline: Deleting the organization is for owners only; a <role> has no access
      Given Grace has joined "Acme" with the <role> role
      And Grace is signed in to the dashboard
      When they open the address of the organization "Acme" followed by "/delete"
      Then they are told they have no access
      And they see "Deleting the organization is for owners of Acme. You are <article> <role>."

      Examples:
        | role   | article |
        | member | a       |
        | admin  | an      |

    Scenario: An admin who opens the address for changing an owner's role has no access
      Given Grace has joined "Acme" with the admin role
      And Grace is signed in to the dashboard
      When they open the address of the member Ada of "Acme" followed by "/role"
      Then they are told they have no access
      And they see "Only an owner can change or remove an owner of Acme."

    Scenario: A member who opens the address for removing someone has no access
      Given Grace has joined "Acme" with the member role
      And Grace is signed in to the dashboard
      When they open the address of the member Linus of "Acme" followed by "/remove"
      Then they are told they have no access

  Rule: A member can make every change to a fleet

    Scenario Outline: A <role> renames a fleet
      Given Grace has joined "Acme" with the <role> role
      And Grace is signed in to the dashboard
      When they open the fleet "Staging"
      And they follow "Rename the fleet"
      And they type "Preview" into "Name"
      And they press "Rename fleet"
      Then the setting "Name" is noted "Renamed just now"

      Examples:
        | role   |
        | member |
        | admin  |
