@tenancy
Feature: Audit log
  Every change made in an organization is recorded with who made it and what they did, so an
  admin can answer "who changed this?". Entries name the API operation that made the change.

  Background:
    Given Ada owns an organization "Acme"
    And Ada has a project "Web" in "Acme"
    And Ada has a fleet "Staging" in the project "Web" with a "resend" emulator named "mail"

  Rule: Every change is recorded, newest first

    Scenario: The log lists changes from the newest to the oldest
      When Ada reads the audit log of "Acme"
      Then the request succeeds
      And the audit log of "Acme" reads, newest first:
        | who | did           |
        | Ada | createFleet   |
        | Ada | createProject |
        | Ada | createOrg     |

    Scenario: Changes to the organization and its people are recorded
      Given Ada renames the organization "Acme" to "Acme Corporation"
      And Ada invites Grace to "Acme" as a viewer
      And Ada invites Linus to "Acme" as a member
      And Ada revokes the invite for Linus in "Acme"
      And Grace accepts their invite
      And Ada changes Grace's role in "Acme" to member
      And Ada removes Grace from "Acme"
      Then the audit log of "Acme" reads, newest first:
        | who   | did           |
        | Ada   | removeMember  |
        | Ada   | updateMember  |
        | Grace | acceptInvite  |
        | Ada   | deleteInvite  |
        | Ada   | createInvite  |
        | Ada   | createInvite  |
        | Ada   | updateOrg     |
        | Ada   | createFleet   |
        | Ada   | createProject |
        | Ada   | createOrg     |

    Scenario: Changes to projects, fleets and emulators are recorded
      Given Ada renames the project "Web" to "Website"
      And Ada renames the fleet "Staging" to "Pre-production"
      And Ada adds a "stripe" emulator named "payments" to the fleet "Staging"
      And Ada changes the emulator "payments" of the fleet "Staging" with:
        | durability | strict |
      And Ada removes the emulator "payments" from the fleet "Staging"
      And Ada deletes the fleet called "Staging"
      And Ada deletes the project "Web"
      Then the audit log of "Acme" reads, newest first:
        | who | did            |
        | Ada | deleteProject  |
        | Ada | deleteFleet    |
        | Ada | deleteEmulator |
        | Ada | updateEmulator |
        | Ada | putEmulator    |
        | Ada | updateFleet    |
        | Ada | updateProject  |
        | Ada | createFleet    |
        | Ada | createProject  |
        | Ada | createOrg      |

    Scenario: Making and revoking keys is recorded
      Given Ada has an organization key "ci" for "Acme" with the member role
      And Ada revokes the key "ci" in "Acme"
      Then the latest entries in the audit log of "Acme" are:
        | who | did          |
        | Ada | deleteApiKey |
        | Ada | createApiKey |

    Scenario: Each entry says what was changed
      When Ada changes the emulator "mail" of the fleet "Staging" with:
        | durability | buffered |
      Then the latest audit entry of "Acme" is about the emulator "mail" of the fleet "Staging"

    Scenario: Each entry says when the change was made
      Then every entry in the audit log of "Acme" is timestamped, never later than now

  Rule: Each entry names who made the change

    Scenario: A person is named with their email address
      Then the latest audit entry of "Acme" was made by the person Ada

    Scenario: A key is named with its name
      Given Ada has an organization key "ci" for "Acme" with the member role
      When the key "ci" attempts to rename the fleet
      Then the latest audit entry of "Acme" was made by the key "ci"

    Scenario: A personal token's changes are its person's
      Given Ada has a personal token "laptop"
      When the token "laptop" attempts to rename the fleet
      Then the latest audit entry of "Acme" was made by the person Ada

    Scenario: The operator of the service is named as the operator
      When the operator changes a quota of "Acme"
      Then the latest audit entry of "Acme" was made by the operator

  Rule: Only changes that happened are recorded

    Scenario: Looking is not recorded
      Given Ada attempts to view the fleet
      And Ada attempts to list the members
      And Ada attempts to list the API keys
      Then the audit log of "Acme" has 3 entries

    Scenario: A refused change is not recorded
      Given Grace has joined "Acme" with the viewer role
      And the audit log of "Acme" has 5 entries
      When Grace attempts to delete the fleet
      Then the attempt is forbidden
      And the audit log of "Acme" has 5 entries

    Scenario: An invalid change is not recorded
      When Ada renames the fleet "Staging" to ""
      Then the audit log of "Acme" has 3 entries

    Scenario: An outsider's attempt leaves no trace
      Given Mallory is signed in
      When Mallory attempts to delete the fleet
      Then the audit log of "Acme" has 3 entries

  Rule: The log keeps secrets out and is for admins only

    Scenario: Secrets never appear in the log
      Given Ada has an organization key "ci" for "Acme" with the admin role
      And Ada has a project key "web-ci" for the project "Web" with the member role
      And Ada has invited Grace to "Acme" as a member
      When Ada reads the audit log of "Acme"
      Then the audit log reveals neither key secrets nor invite links

    Scenario Outline: A <role> who reads the audit log is <outcome>
      Given Grace has joined "Acme" with the <role> role
      When Grace attempts to read the audit log
      Then the attempt is <outcome>

      Examples:
        | role   | outcome   |
        | viewer | forbidden |
        | member | forbidden |
        | admin  | allowed   |
        | owner  | allowed   |

    Scenario: Each organization has its own log
      Given Grace owns an organization "Globex"
      And Grace has a project "Api" in "Globex"
      Then the audit log of "Globex" reads, newest first:
        | who   | did           |
        | Grace | createProject |
        | Grace | createOrg     |

  Rule: The log shows the most recent changes

    @slow
    Scenario: Only the 200 most recent changes are listed
      Given Ada renames the organization "Acme" 205 times
      Then the audit log of "Acme" has 200 entries
      And the latest audit entry of "Acme" was made by the person Ada
