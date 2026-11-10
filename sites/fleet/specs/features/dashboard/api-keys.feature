@dashboard
Feature: API keys in the dashboard
  Keys let CI and agents call the API and protected fleets. An admin creates and revokes them on
  the API keys tab. A key's secret is shown exactly once, when it is created.

  Background:
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"
    And Ada has a project "Web app" in "Acme"

  Scenario: An organization without keys says so
    When they open the "API keys" tab of "Acme"
    Then they see "No API keys yet."
    And they see "Keys let CI and agents call the API and protected fleets. An organization key reaches every project; a project key reaches one."

  Scenario: Creating an organization key shows its secret once
    When they open the "API keys" tab of "Acme"
    And they type "ci" into "Key name"
    And they choose "admin" as the "Role"
    And they press "Create key"
    Then they see "API key created. Copy it now; it will not be shown again."
    And a secret starting with "mbf_o_" is shown
    And the key "ci" is listed as "admin"
    And the key "ci" says "last used never"

  Scenario: The secret that was shown works as a credential
    When they open the "API keys" tab of "Acme"
    And they type "ci" into "Key name"
    And they press "Create key"
    Then the secret on screen can read the organization "Acme" through the API

  Scenario: Creating a project key scopes it to that project
    When they open the "API keys" tab of "Acme"
    And they type "web preview" into "Key name"
    And they choose "Project: Web app" as the "Scope"
    And they choose "viewer" as the "Role"
    And they press "Create key"
    Then a secret starting with "mbf_p_" is shown
    And the key "web preview" is listed as "project viewer"

  Scenario: The secret is gone after leaving the page
    When they open the "API keys" tab of "Acme"
    And they type "ci" into "Key name"
    And they press "Create key"
    And they follow "Members"
    And they go back
    Then no secret is shown
    And the key "ci" is listed as "member"

  Scenario: The secret is gone after reloading the page
    When they open the "API keys" tab of "Acme"
    And they type "ci" into "Key name"
    And they press "Create key"
    And they reload the page
    Then no secret is shown

  Scenario: Revoking a key asks first, then removes it
    Given Ada has an organization key "ci" for "Acme" with the member role
    When they open the "API keys" tab of "Acme"
    And they revoke the key "ci" and confirm
    Then they were asked "Revoke ci? Anything using it stops working."
    And they see "No API keys yet."
    And the key "ci" no longer works

  Scenario: Declining the question keeps the key
    Given Ada has an organization key "ci" for "Acme" with the member role
    When they open the "API keys" tab of "Acme"
    And they revoke the key "ci" and decline
    And they reload the page
    Then the key "ci" is listed as "member"

  Scenario: An admin manages keys too
    Given Grace has joined "Acme" with the admin role
    And Grace is signed in to the dashboard
    When they open the "API keys" tab of "Acme"
    And they type "deploy" into "Key name"
    And they choose "admin" as the "Role"
    And they press "Create key"
    Then the key "deploy" is listed as "admin"
