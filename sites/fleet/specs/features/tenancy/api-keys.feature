@tenancy
Feature: API keys and personal tokens
  Automation authenticates with keys. An organization key acts with a role across one
  organization, a project key is confined to one project, and a personal token acts as the person
  who made it. A key's secret is shown once, when it is made.

  Background:
    Given Ada owns an organization "Acme"
    And Ada has a project "Web" in "Acme"
    And Ada has a fleet "Staging" in the project "Web" with a "resend" emulator named "mail"
    And Ada has a project "Mobile" in "Acme"
    And Ada has a fleet "Beta" in the project "Mobile"

  Rule: A key's secret is shown once

    Scenario: Making an organization key reveals its secret
      When Ada makes an organization key "ci" for "Acme"
      Then the response status is 201
      And the new key is an organization key with the member role
      And the new key's secret is revealed

    Scenario: Making a project key reveals its secret
      When Ada makes a project key "web-ci" for the project "Web" in "Acme"
      Then the response status is 201
      And the new key is a project key with the member role
      And the new key's secret is revealed

    Scenario: Afterwards a key is known only by its prefix
      Given Ada has an organization key "ci" for "Acme" with the member role
      When Ada lists the API keys of "Acme"
      Then the key "ci" is listed by its prefix, without its secret

    Scenario: A key shows when it was last used
      Given Ada has an organization key "ci" for "Acme" with the member role
      And the key "ci" is listed in "Acme" as never used
      When the key "ci" asks who they are
      Then the key "ci" is listed in "Acme" as used

    Scenario: A key may be made to expire
      When Ada makes an organization key "temp" for "Acme" that expires in 30 days
      Then the new key expires 30 days after it was made

    Scenario: A key without an expiry never expires
      When Ada makes an organization key "ci" for "Acme"
      Then the new key never expires

    Scenario Outline: A key with <problem> is refused
      When Ada tries to make an organization key for "Acme" with <problem>
      Then the request is refused as "invalid_request"
      And "Acme" has no API keys

      Examples:
        | problem                  |
        | no name                  |
        | a blank name             |
        | an expiry of 0 days      |
        | an expiry of 367 days    |
        | a role that is not known |

  Rule: An organization key acts with its role, in its organization only

    Scenario Outline: A <role> key that attempts to <action> is <outcome>
      Given Ada has an organization key "ci" for "Acme" with the <role> role
      When the key "ci" attempts to <action>
      Then the attempt is <outcome>

      Examples:
        | role   | action                  | outcome   |
        | viewer | view the fleet          | allowed   |
        | viewer | list the projects       | allowed   |
        | viewer | create a fleet          | forbidden |
        | member | create a fleet          | allowed   |
        | member | add an emulator         | allowed   |
        | member | delete the project      | forbidden |
        | member | create an API key       | forbidden |
        | admin  | delete the project      | allowed   |
        | admin  | invite someone          | allowed   |
        | admin  | create an API key       | allowed   |
        | admin  | read the audit log      | allowed   |
        | admin  | delete the organization | forbidden |

    Scenario: A key reaches its own organization and no other
      Given Grace owns an organization "Globex"
      And Ada has an organization key "ci" for "Acme" with the admin role
      When the key "ci" lists the organizations they belong to
      Then the organizations listed are "Acme"

    Scenario: Another organization's key finds nothing here
      Given Grace owns an organization "Globex"
      And Grace has an organization key "theirs" for "Globex" with the admin role
      When the key "theirs" attempts to view the fleet
      Then the attempt is not found

  Rule: A key never outranks whoever made it

    Scenario: No key can be an owner
      When Ada makes an organization key "root" for "Acme" with the owner role
      Then the request is refused as "invalid_request"
      And "Acme" has no API keys

    Scenario: An admin key can make keys up to its own rank
      Given Ada has an organization key "ops" for "Acme" with the admin role
      When the key "ops" makes an organization key "child" for "Acme" with the admin role
      Then the response status is 201
      And the new key is an organization key with the admin role

    Scenario: A key made by a key cannot be an owner either
      Given Ada has an organization key "ops" for "Acme" with the admin role
      When the key "ops" makes an organization key "root" for "Acme" with the owner role
      Then the request is refused as "invalid_request"

  Rule: A project key is confined to its project

    Scenario Outline: Inside its project, a member project key that attempts to <action> is allowed
      Given Ada has a project key "web-ci" for the project "Web" with the member role
      When the key "web-ci" attempts to <action>
      Then the attempt is allowed

      Examples:
        | action                  |
        | view the project        |
        | list the fleets         |
        | view the fleet          |
        | create a fleet          |
        | add an emulator         |
        | reconfigure an emulator |
        | delete the fleet        |

    Scenario: A viewer project key only looks
      Given Ada has a project key "web-ro" for the project "Web" with the viewer role
      When the key "web-ro" attempts to create a fleet
      Then the attempt is forbidden

    Scenario: It cannot see another project of the same organization
      Given Ada has a project key "web-ci" for the project "Web" with the member role
      When the key "web-ci" asks for the project "Mobile"
      Then the request is refused as "not_found"

    Scenario: It cannot see a fleet of another project
      Given Ada has a project key "web-ci" for the project "Web" with the member role
      When the key "web-ci" asks for the fleet "Beta"
      Then the request is refused as "not_found"

    Scenario: It lists only its own project
      Given Ada has a project key "web-ci" for the project "Web" with the member role
      When the key "web-ci" lists the projects of "Acme"
      Then the projects listed are "Web"

    Scenario Outline: A project key that attempts to <action> finds nothing
      Given Ada has a project key "web-ci" for the project "Web" with the member role
      When the key "web-ci" attempts to <action>
      Then the attempt is not found

      Examples:
        | action                  |
        | view the organization   |
        | list the members        |
        | create a project        |
        | create an API key       |
        | read the audit log      |
        | delete the organization |

    Scenario: A project key is at most a member
      When Ada makes a project key "web-admin" for the project "Web" in "Acme" with the admin role
      Then the request is refused as "invalid_request"
      And the message says "A project key is at most a member"
      And "Acme" has no API keys

    Scenario: A project key cannot be made for another organization's project
      Given Grace owns an organization "Globex"
      And Grace has a project "Secret" in "Globex"
      When Ada makes a project key "sneaky" for the project "Secret" in "Acme"
      Then the request is refused as "not_found"
      And "Acme" has no API keys

    Scenario: Deleting a project revokes its keys
      Given Ada has a project key "web-ci" for the project "Web" with the member role
      And Ada has an organization key "ci" for "Acme" with the member role
      When Ada deletes the project "Web"
      Then the key "web-ci" is no longer accepted
      And the key "ci" is still accepted

  Rule: A revoked or expired key stops working at once

    Scenario: A revoked key is refused
      Given Ada has an organization key "ci" for "Acme" with the member role
      When Ada revokes the key "ci" in "Acme"
      Then the request succeeds
      And the key "ci" is no longer accepted
      And "Acme" has no API keys

    Scenario: A key can only be revoked from its own organization
      Given Ada has an organization key "ci" for "Acme" with the member role
      And Mallory owns an organization "Globex"
      When Mallory revokes the key "ci" in "Globex"
      Then the request is refused as "not_found"
      And the key "ci" is still accepted

    Scenario: A key stops working when it expires
      Given Ada makes an organization key "temp" for "Acme" that expires in 1 day
      When the key "temp" has passed its expiry
      Then the key "temp" is no longer accepted

  Rule: A personal token belongs to one person and acts as them everywhere

    Scenario: Making a personal token reveals its secret
      When Ada makes a personal token "laptop"
      Then the response status is 201
      And the new key is a personal token
      And the new key's secret is revealed

    Scenario: A personal token reaches every organization its person belongs to
      Given Grace owns an organization "Globex"
      And Ada has joined "Globex" with the viewer role
      And Ada has a personal token "laptop"
      When the token "laptop" lists the organizations they belong to
      Then the organizations listed are "Acme, Globex"

    Scenario: A personal token has its person's role in each organization
      Given Grace owns an organization "Globex"
      And Ada has joined "Globex" with the viewer role
      And Ada has a personal token "laptop"
      When the token "laptop" makes an organization key "ci" for "Globex"
      Then the request is refused as "forbidden"

    Scenario: People see their own tokens only, and never the secrets
      Given Ada has a personal token "laptop"
      And Grace has a personal token "desktop"
      When Ada lists their personal tokens
      Then the personal tokens listed are "laptop"
      And the token "laptop" is listed by its prefix, without its secret

    Scenario: Personal tokens are not among an organization's keys
      Given Ada has a personal token "laptop"
      Then "Acme" has no API keys

    Scenario: A revoked personal token is refused
      Given Ada has a personal token "laptop"
      When Ada revokes the personal token "laptop"
      Then the request succeeds
      And the token "laptop" is no longer accepted

    Scenario: Nobody can revoke someone else's personal token
      Given Ada has a personal token "laptop"
      When Grace revokes the personal token "laptop"
      Then the request is refused as "not_found"
      And the token "laptop" is still accepted

    Scenario: A personal token can make another personal token
      Given Ada has a personal token "laptop"
      When the token "laptop" makes a personal token "ci"
      Then the response status is 201

    Scenario: An organization key cannot make or list personal tokens
      Given Ada has an organization key "ci" for "Acme" with the admin role
      When the key "ci" makes a personal token "sneaky"
      Then the request is refused as "forbidden"

    Scenario: A personal token needs a name
      When Ada tries to make a personal token without a name
      Then the request is refused as "invalid_request"
