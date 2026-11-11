@tenancy
Feature: Members and roles
  Everyone in an organization holds one role. Roles are ordered viewer < member < admin < owner,
  and each can do everything the roles below it can.

  Background:
    Given Ada owns an organization "Acme"
    And Ada has a project "Web" in "Acme"
    And Ada has a fleet "Staging" in the project "Web" with a "resend" emulator named "mail"
    And Tess has joined "Acme" with the member role

  Rule: Every action needs a minimum role

    Scenario Outline: Looking around: a <role> who attempts to <action> is <outcome>
      Given Grace has joined "Acme" with the <role> role
      When Grace attempts to <action>
      Then the attempt is <outcome>

      Examples:
        | action                | role   | outcome |
        | view the organization | viewer | allowed |
        | list the members      | viewer | allowed |
        | list the projects     | viewer | allowed |
        | view the project      | viewer | allowed |
        | list the fleets       | viewer | allowed |
        | view the fleet        | viewer | allowed |

    Scenario Outline: Building needs a member: a <role> who attempts to <action> is <outcome>
      Given Grace has joined "Acme" with the <role> role
      When Grace attempts to <action>
      Then the attempt is <outcome>

      Examples:
        | action                        | role   | outcome   |
        | create a project              | viewer | forbidden |
        | create a project              | member | allowed   |
        | rename the project            | viewer | forbidden |
        | rename the project            | member | allowed   |
        | create a fleet                | viewer | forbidden |
        | create a fleet                | member | allowed   |
        | rename the fleet              | viewer | forbidden |
        | rename the fleet              | member | allowed   |
        | change who can call the fleet | viewer | forbidden |
        | change who can call the fleet | member | allowed   |
        | add an emulator               | viewer | forbidden |
        | add an emulator               | member | allowed   |
        | reconfigure an emulator       | viewer | forbidden |
        | reconfigure an emulator       | member | allowed   |
        | remove an emulator            | viewer | forbidden |
        | remove an emulator            | member | allowed   |
        | delete the fleet              | viewer | forbidden |
        | delete the fleet              | member | allowed   |

    Scenario Outline: Administering needs an admin: a <role> who attempts to <action> is <outcome>
      Given Grace has joined "Acme" with the <role> role
      When Grace attempts to <action>
      Then the attempt is <outcome>

      Examples:
        | action                   | role   | outcome   |
        | delete the project       | member | forbidden |
        | delete the project       | admin  | allowed   |
        | rename the organization  | member | forbidden |
        | rename the organization  | admin  | allowed   |
        | invite someone           | member | forbidden |
        | invite someone           | admin  | allowed   |
        | list the pending invites | member | forbidden |
        | list the pending invites | admin  | allowed   |
        | revoke an invite         | member | forbidden |
        | revoke an invite         | admin  | allowed   |
        | create an API key        | member | forbidden |
        | create an API key        | admin  | allowed   |
        | list the API keys        | member | forbidden |
        | list the API keys        | admin  | allowed   |
        | revoke an API key        | member | forbidden |
        | revoke an API key        | admin  | allowed   |
        | read the audit log       | member | forbidden |
        | read the audit log       | admin  | allowed   |
        | change a teammate's role | member | forbidden |
        | change a teammate's role | admin  | allowed   |
        | remove a teammate        | member | forbidden |
        | remove a teammate        | admin  | allowed   |

    Scenario Outline: Owning: a <role> who attempts to <action> is <outcome>
      Given Grace has joined "Acme" with the <role> role
      When Grace attempts to <action>
      Then the attempt is <outcome>

      Examples:
        | action                   | role  | outcome   |
        | make a teammate an owner | admin | forbidden |
        | make a teammate an owner | owner | allowed   |
        | delete the organization  | admin | forbidden |
        | delete the organization  | owner | allowed   |

  Rule: Outsiders cannot tell that an organization or anything in it exists

    Scenario Outline: An outsider who attempts to <action> is told nothing is there
      Given Mallory is signed in
      When Mallory attempts to <action>
      Then the attempt is not found

      Examples:
        | action                   |
        | view the organization    |
        | list the members         |
        | list the projects        |
        | view the project         |
        | list the fleets          |
        | view the fleet           |
        | create a project         |
        | rename the project       |
        | delete the project       |
        | create a fleet           |
        | rename the fleet         |
        | add an emulator          |
        | reconfigure an emulator  |
        | remove an emulator       |
        | delete the fleet         |
        | rename the organization  |
        | invite someone           |
        | list the pending invites |
        | revoke an invite         |
        | create an API key        |
        | list the API keys        |
        | revoke an API key        |
        | read the audit log       |
        | change a teammate's role |
        | remove a teammate        |
        | delete the organization  |

    Scenario Outline: Someone who is not signed in and attempts to <action> must sign in first
      When an anonymous caller attempts to <action>
      Then the attempt is refused for lack of credentials

      Examples:
        | action                  |
        | view the organization   |
        | view the project        |
        | view the fleet          |
        | create a project        |
        | delete the fleet        |
        | delete the organization |

    Scenario: Belonging to another organization grants nothing here
      Given Mallory owns an organization "Globex"
      When Mallory attempts to delete the fleet
      Then the attempt is not found

  Rule: Admins manage everyone below owner

    Scenario: The member list shows everyone and their role
      Given Grace has joined "Acme" with the viewer role
      Then the members of "Acme" are:
        | person | role   |
        | Ada    | owner  |
        | Tess   | member |
        | Grace  | viewer |

    Scenario: A promotion takes effect at once
      Given Grace has joined "Acme" with the viewer role
      When Ada changes Grace's role in "Acme" to admin
      Then the request succeeds
      And Grace is an admin of "Acme"

    Scenario: A demotion takes effect at once
      When Ada changes Tess's role in "Acme" to viewer
      And Tess attempts to create a project
      Then the attempt is forbidden

    Scenario: An admin changes the roles of people below owner
      Given Grace has joined "Acme" with the admin role
      When Grace changes Tess's role in "Acme" to admin
      Then the request succeeds
      And Tess is an admin of "Acme"

    Scenario: An admin cannot make anyone an owner
      Given Grace has joined "Acme" with the admin role
      When Grace changes Tess's role in "Acme" to owner
      Then the request is refused as "forbidden"
      And the message says "Only an owner can grant or change the owner role"
      And Tess is still a member of "Acme"

    Scenario: An admin cannot change an owner's role
      Given Grace has joined "Acme" with the admin role
      When Grace changes Ada's role in "Acme" to member
      Then the request is refused as "forbidden"
      And Ada is still an owner of "Acme"

    Scenario: An admin cannot remove an owner
      Given Grace has joined "Acme" with the admin role
      When Grace removes Ada from "Acme"
      Then the request is refused as "forbidden"
      And the message says "Only an owner can remove an owner"
      And Ada is still an owner of "Acme"

    Scenario: An owner makes someone else an owner
      When Ada changes Tess's role in "Acme" to owner
      Then the request succeeds
      And Tess is an owner of "Acme"

    Scenario: Nobody can promote themselves
      When Tess changes Tess's role in "Acme" to admin
      Then the request is refused as "forbidden"
      And Tess is still a member of "Acme"

    Scenario: A role that does not exist is refused
      When Ada changes Tess's role in "Acme" to superuser
      Then the request is refused as "invalid_request"
      And Tess is still a member of "Acme"

    Scenario: Someone who is not a member has no role to change
      Given Mallory is signed in
      When Ada changes Mallory's role in "Acme" to member
      Then the request is refused as "not_found"
      And "Acme" has 2 members

  Rule: An organization always has an owner

    Scenario: The last owner cannot leave
      When Ada leaves "Acme"
      Then the request is refused as "conflict"
      And the message says "An organization needs at least one owner"
      And Ada is still an owner of "Acme"

    Scenario: The last owner cannot be demoted
      When Ada changes Ada's role in "Acme" to admin
      Then the request is refused as "conflict"
      And the message says "An organization needs at least one owner"
      And Ada is still an owner of "Acme"

    Scenario: With a second owner, the first may step down
      Given Grace has joined "Acme" with the owner role
      When Ada changes Ada's role in "Acme" to admin
      Then the request succeeds
      And Ada is an admin of "Acme"

    Scenario: With a second owner, the first may leave
      Given Grace has joined "Acme" with the owner role
      When Ada leaves "Acme"
      Then the request succeeds
      And Ada cannot see "Acme"

    Scenario: One owner can remove another
      Given Grace has joined "Acme" with the owner role
      When Grace removes Ada from "Acme"
      Then the request succeeds
      And Ada cannot see "Acme"

  Rule: People leave, or are removed, and lose access at once

    Scenario Outline: A <role> can leave by themselves
      Given Grace has joined "Acme" with the <role> role
      When Grace leaves "Acme"
      Then the request succeeds
      And Grace cannot see "Acme"
      And "Acme" has 2 members

      Examples:
        | role   |
        | viewer |
        | member |
        | admin  |

    Scenario: A removed member loses access at once
      When Ada removes Tess from "Acme"
      Then the request succeeds
      And Tess cannot see "Acme"
      And "Acme" has 1 member

    Scenario: Someone who is not a member cannot be removed
      Given Mallory is signed in
      When Ada removes Mallory from "Acme"
      Then the request is refused as "not_found"
