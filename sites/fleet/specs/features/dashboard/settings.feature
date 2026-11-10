@dashboard
Feature: Organization settings in the dashboard
  Admins rename an organization on its Settings tab; only an owner can delete it, and only
  after confirming.

  Background:
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"

  Scenario: Renaming an organization
    When they open the "Settings" tab of "Acme"
    And they type "Acme Corporation" into "Organization name"
    And they press "Rename"
    Then they see the page "Acme Corporation"
    When they reload the page
    Then they see the page "Acme Corporation"

  Scenario: Deleting an organization asks first, then returns to the list
    When they open the "Settings" tab of "Acme"
    Then they see "Deletes every project, fleet, API key and all stored emulator state. This cannot be undone."
    When they press "Delete organization" and confirm
    Then they were asked "Delete Acme and everything in it?"
    And they see the page "Organizations"
    And they see "No organizations yet"

  Scenario: Declining the question keeps the organization
    When they open the "Settings" tab of "Acme"
    And they press "Delete organization" and decline
    And they reload the page
    Then they see the page "Acme"

  Scenario: An admin can rename but is not offered deletion
    Given Grace has joined "Acme" with the admin role
    And Grace is signed in to the dashboard
    When they open the "Settings" tab of "Acme"
    Then there is a button "Rename"
    And there is no button "Delete organization"
