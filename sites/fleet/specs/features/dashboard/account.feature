@dashboard
Feature: The account page in the dashboard
  A personal token acts as its owner everywhere they are a member. People create and revoke
  their own on the Account page; the secret is shown exactly once.

  Background:
    Given Ada is signed in to the dashboard

  Scenario: The account page names who is signed in
    When they open the dashboard
    And they follow "Account"
    Then they see the page "Account"
    And they see the email of Ada
    And they see "No personal tokens yet."

  Scenario: Creating a personal token shows its secret once
    When they open the dashboard at "/account"
    And they type "laptop" into "Token name"
    And they press "Create token"
    Then they see "Token created. Copy it now; it will not be shown again."
    And a secret starting with "mbf_u_" is shown
    And the token "laptop" is listed

  Scenario: The token that was shown signs its owner in elsewhere
    When they open the dashboard at "/account"
    And they type "laptop" into "Token name"
    And they press "Create token"
    And someone uses the secret on screen to sign in from another browser
    Then they see the page "Organizations"
    When they follow "Account"
    Then they see the email of Ada

  Scenario: The secret is gone after leaving the page
    When they open the dashboard at "/account"
    And they type "laptop" into "Token name"
    And they press "Create token"
    And they follow "API"
    And they follow "Account"
    Then no secret is shown
    And the token "laptop" is listed

  Scenario: Revoking a token asks first, then removes it
    Given Ada has a personal token "laptop"
    When they open the dashboard at "/account"
    And they revoke the token "laptop" and confirm
    Then they were asked "Revoke laptop? Anything using it stops working."
    And they see "No personal tokens yet."
    And the key "laptop" no longer works
