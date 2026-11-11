@dashboard
Feature: The audit log in the dashboard
  Admins and owners can see who changed what in their organization, newest first. The log only
  shows; it changes nothing.

  Background:
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"

  Scenario: The log says how much it holds
    When they open the "Audit log" tab of "Acme"
    Then they see "The 200 most recent changes, newest first. Entries are kept for 90 days."

  Scenario: A change shows up with who made it
    Given Ada has a project "Web app" in "Acme"
    When they open the "Audit log" tab of "Acme"
    Then the audit log shows "createProject" by Ada

  Scenario: A change made by a key names the key
    Given Ada has an organization key "ci" for "Acme" with the member role
    And the key "ci" has created a project "Mobile app" in "Acme"
    When they open the "Audit log" tab of "Acme"
    Then the audit log shows "createProject" by the key "ci"

  Scenario: A change made in the dashboard is logged
    When they open the "Settings" tab of "Acme"
    And they follow "Rename the organization"
    And they type "Acme Corporation" into "Name"
    And they press "Rename organization"
    And they follow "Audit log"
    Then the audit log shows "updateOrg" by Ada

  Scenario: The newest change is listed first
    Given Ada has a project "Web app" in "Acme"
    And Ada has a fleet "Staging" in the project "Web app"
    When they open the "Audit log" tab of "Acme"
    Then the first audit entry is "createFleet"
