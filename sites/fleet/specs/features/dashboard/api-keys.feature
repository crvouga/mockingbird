@dashboard
Feature: API keys in the dashboard
  Keys let CI and agents call the API and fleets that require a key. The API keys tab lists them;
  an admin creates one on a screen of its own, sees its secret once on the screen that follows,
  and revokes one on a screen of its own.

  Background:
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"
    And Ada has a project "Web app" in "Acme"

  Rule: The API keys tab lists the keys

    Scenario: An organization without keys says what they are for
      When they open the "API keys" tab of "Acme"
      Then they see "No API keys yet"
      And they see "Keys let CI and agents call the API and fleets that require a key. An organization key reaches every project; a project key reaches one."
      And there is a link "New API key"

    Scenario: Keys are listed with their scope and role, never with their secret
      Given Ada has an organization key "ci" for "Acme" with the member role
      And Ada has a project key "preview" for the project "Web app" with the viewer role
      When they open the "API keys" tab of "Acme"
      Then the key "ci" is listed as "organization: member"
      And the key "preview" is listed as "Web app: viewer"
      And the key "ci" says "Last used never"
      And the secret of the key "ci" is not on the page

  Rule: A key is created on a screen of its own and its secret is shown once

    Scenario: Creating an organization key shows its secret once
      When they open the "API keys" tab of "Acme"
      And they follow "New API key"
      Then they see the page "New API key"
      And the screen is the "key.new" form
      And "Member" is chosen for "Role"
      When they type "ci" into "Name"
      And they choose "Admin" as the "Role"
      And they press "Create API key"
      Then they see the page "API key created"
      And a secret starting with "mbf_o_" is shown
      When they follow "Done"
      Then they see the page "Acme"
      And the "API keys" tab is the current one
      And the key "ci" is listed as "organization: admin"

    Scenario: The secret that was shown works as a credential
      When they open the "API keys" tab of "Acme"
      And they follow "New API key"
      And they type "ci" into "Name"
      And they press "Create API key"
      Then the secret on screen can read the organization "Acme" through the API

    Scenario: Creating a project key scopes it to that project
      When they open the "API keys" tab of "Acme"
      And they follow "New API key"
      And they type "web preview" into "Name"
      And they choose "Project: Web app" as the "Scope"
      And they choose "Viewer" as the "Role"
      And they press "Create API key"
      Then a secret starting with "mbf_p_" is shown
      When they follow "Done"
      Then the key "web preview" is listed as "Web app: viewer"

    Scenario: A project key cannot be an admin, which is pointed out before asking the server
      When they open the "API keys" tab of "Acme"
      And they follow "New API key"
      And they type "web preview" into "Name"
      And they choose "Project: Web app" as the "Scope"
      And they choose "Admin" as the "Role"
      And they press "Create API key"
      Then the field "Role" says "A project key is at most a member."
      And exactly 1 problem is pointed out
      And they see the page "New API key"

    Scenario: An empty name is pointed out under the field
      When they open the "API keys" tab of "Acme"
      And they follow "New API key"
      And they press "Create API key"
      Then the field "Name" says "Enter a name for the key."
      And they see the page "New API key"

    Scenario: The secret is gone after leaving its screen
      When they open the "API keys" tab of "Acme"
      And they follow "New API key"
      And they type "ci" into "Name"
      And they press "Create API key"
      And they follow "Done"
      And they go back
      Then they are told the secret was shown once

    Scenario: The secret is gone after reloading its screen
      When they open the "API keys" tab of "Acme"
      And they follow "New API key"
      And they type "ci" into "Name"
      And they press "Create API key"
      And they reload the page
      Then they are told the secret was shown once

    Scenario: Cancel returns to the API keys tab and creates no key
      When they open the "API keys" tab of "Acme"
      And they follow "New API key"
      And they type "ci" into "Name"
      And they cancel
      Then the "API keys" tab is the current one
      And they see "No API keys yet"

    Scenario: An admin creates keys too
      Given Grace has joined "Acme" with the admin role
      And Grace is signed in to the dashboard
      When they open the "API keys" tab of "Acme"
      And they follow "New API key"
      And they type "deploy" into "Name"
      And they press "Create API key"
      And they follow "Done"
      Then the key "deploy" is listed as "organization: member"

  Rule: A key is revoked on a screen of its own

    Background:
      Given Ada has an organization key "ci" for "Acme" with the member role

    Scenario: Revoking a key removes it and stops it working
      When they open the "API keys" tab of "Acme"
      And they follow "Revoke ci"
      Then they see the page "Revoke the API key ci"
      And the screen is the "key.revoke" form
      And they see "A revoked key cannot be restored."
      When they press "Revoke API key"
      Then the "API keys" tab is the current one
      And they see the note "ci was revoked just now."
      And they see "No API keys yet"
      And the key "ci" no longer works

    Scenario: Cancelling keeps the key working
      When they open the "API keys" tab of "Acme"
      And they follow "Revoke ci"
      And they cancel
      Then the key "ci" is listed as "organization: member"
      And the key "ci" still works

    Scenario: A key revoked elsewhere in the meantime is reported in the form
      When they open the "API keys" tab of "Acme"
      And they follow "Revoke ci"
      And Ada revokes the key "ci" in "Acme"
      And they press "Revoke API key"
      Then the form says "The API key was not revoked."
      And no field is marked wrong
      And they see the page "Revoke the API key ci"
