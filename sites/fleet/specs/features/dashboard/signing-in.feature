@dashboard
Feature: Signing in to the dashboard
  The dashboard shows nothing until it knows who is asking. A server offers one or more ways to
  sign in: typing an email on a loopback address, a personal token, or single sign-on through an
  OpenID Connect provider. Whichever is used, the person ends up on the page they asked for, and a
  refused attempt says why on the sign-in screen itself.

  Rule: A server on a loopback address lets people sign in by typing an email

    Background:
      Given a visitor who is not signed in

    Scenario: A visitor who is not signed in is asked to sign in
      When they open the dashboard
      Then they are asked to sign in
      And they see "Local sign-in is available because this server runs on a loopback address."
      And they see "The operator of this server issues tokens with POST /api/v1/admin/users."

    Scenario: Signing in locally opens the dashboard
      When they open the dashboard
      And they sign in locally as Ada
      Then they see the page "Organizations"
      And they see "No organizations yet"

    Scenario: Signing in returns the visitor to the page they asked for
      When they open the dashboard at "/account"
      And they sign in locally as Ada
      Then they see the page "Account"
      And they see the email of Ada
      And the address is "/account"

    Scenario: Signing out ends the session
      When they open the dashboard at "/account"
      And they sign in locally as Ada
      And they press "Sign out"
      Then they are asked to sign in
      When they reload the page
      Then they are asked to sign in

  Rule: A personal token signs its owner in

    Scenario: Signing in with a personal token
      Given Ada has a personal token "laptop"
      And a visitor who is not signed in
      When they open the dashboard at "/account"
      And they sign in with the personal token "laptop"
      Then they see the page "Account"
      And they see the email of Ada

    Scenario: A token that was never issued is refused on the sign-in screen
      Given a visitor who is not signed in
      When they open the dashboard
      And they sign in with the made-up token "mbf_u_never-issued"
      Then they see the error "Malformed API key"
      And they are asked to sign in

    Scenario: An organization key cannot be used to sign in
      Given Ada owns an organization "Acme"
      And Ada has an organization key "ci" for "Acme" with the member role
      And a visitor who is not signed in
      When they open the dashboard
      And they sign in with the personal token "ci"
      Then they see the error "Sign in with a personal token (mbf_u_…), not an organization key"
      And they are asked to sign in

    Scenario: A second refusal replaces the first
      Given a visitor who is not signed in
      When they open the dashboard
      And they sign in with the made-up token "mbf_u_first"
      And they sign in with the made-up token "mbf_u_second"
      Then exactly 1 error is shown

  Rule: Too many attempts from one address are refused with an explanation

    Scenario: A visitor who keeps trying is told to stop
      Given the server is configured with:
        | RATE_LIMIT_AUTH_PER_MINUTE | 1 |
      And a visitor who is not signed in
      When they open the dashboard
      And they sign in with the made-up token "mbf_u_first"
      And they sign in locally as Ada
      Then they see the error "Too many sign-in attempts from this address."
      And they are asked to sign in

  Rule: Single sign-on goes through the identity provider's own pages

    Background:
      Given a dashboard that signs people in through an OpenID Connect provider
      And the provider has an account for Ada
      And a visitor who is not signed in

    Scenario: The sign-in screen offers single sign-on
      When they open the dashboard
      Then they are asked to sign in
      And there is a link "Sign in"

    Scenario: Signing in at the provider opens the dashboard
      When they open the dashboard
      And they follow "Sign in"
      And they choose the account of Ada at the provider and allow access
      Then they see the page "Organizations"
      When they follow "Account"
      Then they see the email of Ada

    Scenario: Single sign-on returns the visitor to the page they asked for
      When they open the dashboard at "/api-reference"
      And they follow "Sign in"
      And they choose the account of Ada at the provider and allow access
      Then they see the page "API reference"
      And the address is "/api-reference"

    Scenario: Cancelling at the provider signs nobody in
      When they open the dashboard
      And they follow "Sign in"
      And they cancel at the provider
      And they open the dashboard
      Then they are asked to sign in

  Rule: When the server cannot be asked, the dashboard says so and offers to try again

    Scenario: The server goes away and comes back
      Given a deployment of its own for this scenario
      And Ada is signed in to the dashboard
      And they open the dashboard at "/account"
      When the server stops
      And they follow "API"
      Then they see the page "Mockingbird Fleet is not responding"
      And there is a button "Try again"
      When the server starts again
      And they press "Try again"
      Then they see the page "API reference"

    Scenario: Being rate limited is explained instead of leaving the page loading
      Given the server is configured with:
        | RATE_LIMIT_API_PER_MINUTE | 4 |
      And Ada is signed in to the dashboard
      When they open the dashboard at "/account"
      And they reload the page until the server refuses
      Then they see the page "Mockingbird Fleet is not responding"
      And they see "Too many API requests."
