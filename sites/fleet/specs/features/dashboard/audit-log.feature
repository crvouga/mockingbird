@dashboard
Feature: The audit log in the dashboard
  Admins and owners can see who changed what in their organization, newest first.

  Background:
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"

  Scenario: The log says how much it holds
    When they open the "Audit log" tab of "Acme"
    Then they see "The 200 most recent changes, newest first. Entries are kept for 90 days."

  Scenario: A change shows up with who made it and what it touched
    Given Ada has a project "Web app" in "Acme"
    When they open the "Audit log" tab of "Acme"
    Then the audit log shows "createProject" by Ada

  Scenario: A change made in the dashboard is logged
    When they open the "Settings" tab of "Acme"
    And they type "Acme Corporation" into "Organization name"
    And they press "Rename"
    And they follow "Audit log"
    Then the audit log shows "updateOrg" by Ada

  Scenario: The newest change is listed first
    Given Ada has a project "Web app" in "Acme"
    And Ada has a fleet "Staging" in the project "Web app"
    When they open the "Audit log" tab of "Acme"
    Then the first audit entry is "createFleet"
