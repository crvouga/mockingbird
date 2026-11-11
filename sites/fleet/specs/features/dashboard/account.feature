@dashboard
Feature: The account page in the dashboard
  The Account page says who is signed in and lists their personal tokens. A personal token acts
  as its owner in every organization they belong to. A token is created on a screen of its own,
  and its secret is shown once, on the screen that follows; it is revoked on a screen of its own.

  Background:
    Given Ada is signed in to the dashboard

  Rule: The account page shows who is signed in and their tokens

    Scenario: The account page names who is signed in
      When they open the dashboard
      And they follow "Account"
      Then they see the page "Account"
      And the setting "Email" reads the email of Ada
      And the setting "Session" reads "This browser"
      And they see "No personal tokens yet"
      And they see "Create one to use the API as yourself."

    Scenario: Personal tokens are listed by name and prefix, never by their secret
      Given Ada has a personal token "laptop"
      When they open the dashboard at "/account"
      Then the token "laptop" is listed
      And the token "laptop" says "Last used never"
      And the secret of the token "laptop" is not on the page

  Rule: A token is created on a screen of its own and shown once

    Scenario: Creating a personal token shows its secret once
      When they open the dashboard at "/account"
      And they follow "New personal token"
      Then they see the page "New personal token"
      And the screen is the "token.new" form
      When they type "laptop" into "Name"
      And they press "Create token"
      Then they see the page "Personal token created"
      And a secret starting with "mbf_u_" is shown
      And there is a link "Done"
      When they follow "Done"
      Then they see the page "Account"
      And the token "laptop" is listed

    Scenario: The token that was shown signs its owner in elsewhere
      When they open the dashboard at "/account/tokens/new"
      And they type "laptop" into "Name"
      And they press "Create token"
      And someone uses the secret on screen to sign in from another browser
      Then they see the page "Organizations"
      When they follow "Account"
      Then they see the email of Ada

    Scenario: The secret is gone after leaving its screen
      When they open the dashboard at "/account/tokens/new"
      And they type "laptop" into "Name"
      And they press "Create token"
      And they follow "Done"
      And they go back
      Then they are told the secret was shown once
      And there is a link "Go to your organizations"

    Scenario: The secret is gone after reloading its screen
      When they open the dashboard at "/account/tokens/new"
      And they type "laptop" into "Name"
      And they press "Create token"
      And they reload the page
      Then they are told the secret was shown once

    Scenario: An empty name is pointed out under the field
      When they open the dashboard at "/account/tokens/new"
      And they press "Create token"
      Then the field "Name" says "Enter a name for the token."
      And exactly 1 problem is pointed out
      And they see the page "New personal token"

    Scenario: Cancel returns to the account page and creates no token
      When they open the dashboard at "/account"
      And they follow "New personal token"
      And they type "laptop" into "Name"
      And they cancel
      Then they see the page "Account"
      And they see "No personal tokens yet"

  Rule: A token is revoked on a screen of its own

    Background:
      Given Ada has a personal token "laptop"

    Scenario: Revoking a token removes it and stops it working
      When they open the dashboard at "/account"
      And they follow "Revoke laptop"
      Then they see the page "Revoke the personal token laptop"
      And the screen is the "token.revoke" form
      And they see "A revoked token cannot be restored."
      When they press "Revoke token"
      Then they see the page "Account"
      And they see the note "laptop was revoked just now."
      And they see "No personal tokens yet"
      And the key "laptop" no longer works

    Scenario: Cancelling keeps the token working
      When they open the dashboard at "/account"
      And they follow "Revoke laptop"
      And they cancel
      Then they see the page "Account"
      And the token "laptop" is listed
      And the key "laptop" still works

    Scenario: A token revoked elsewhere in the meantime is reported in the form
      When they open the dashboard at "/account"
      And they follow "Revoke laptop"
      And Ada revokes the personal token "laptop"
      And they press "Revoke token"
      Then the form says "The token was not revoked."
      And no field is marked wrong
      And they see the page "Revoke the personal token laptop"

    Scenario: The address of a token that does not exist says so
      When they open the dashboard at "/account/tokens/tok_nope/revoke"
      Then they are told it was not found
      And they see "This personal token does not exist, or was already revoked."
