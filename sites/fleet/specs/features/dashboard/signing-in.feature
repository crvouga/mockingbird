@dashboard
Feature: Signing in to the dashboard
  The dashboard shows nothing until it knows who is asking. A server offers one or more ways to
  sign in: typing an email on a loopback address, a personal token, or single sign-on through an
  OpenID Connect provider. The sign-in screen lists them; each way that takes typing has a screen
  of its own with one form. Whichever is used, the person ends up on the page they asked for, and
  a refused attempt says why in that form, under the field it is about.

  Rule: A server on a loopback address lets people sign in by typing an email

    Background:
      Given a visitor who is not signed in

    Scenario: A visitor who is not signed in is asked to sign in
      When they open the dashboard
      Then they are asked to sign in
      And they are offered the ways to sign in "Sign in locally, Sign in with a token"
      And they see "Offered only because this server runs on a loopback address."
      And they see "Paste a personal token (mbf_u_…) issued by the operator of this server."

    Scenario: Signing in locally opens the dashboard
      When they open the dashboard
      And they choose to "Sign in locally"
      Then they see the page "Sign in locally"
      When they type the email of Ada into "Email"
      And they press "Sign in"
      Then they see the page "Organizations"
      And they see "You are not in any organization yet"

    Scenario: Signing in returns the visitor to the page they asked for
      When they open the dashboard at "/account"
      And they sign in locally as Ada
      Then they see the page "Account"
      And they see the email of Ada
      And the address is "/account"

    Scenario: An address without an @ is refused under the field, before asking the server
      When they open the dashboard
      And they choose to "Sign in locally"
      And they type "ada" into "Email"
      And they press "Sign in"
      Then the field "Email" says "Enter an email address with an @, like you@example.test."
      And exactly 1 problem is pointed out
      And they see the page "Sign in locally"

    Scenario: Cancel returns to the ways to sign in, still headed for the page asked for
      When they open the dashboard at "/account"
      And they choose to "Sign in locally"
      And they cancel
      Then they are asked to sign in
      When they sign in locally as Ada
      Then they see the page "Account"

  Rule: Signing out is a screen of its own

    Background:
      Given Ada is signed in to the dashboard

    Scenario: Signing out ends the session and says so on the sign-in screen
      When they open the dashboard at "/account"
      And they follow "Sign out"
      Then they see the page "Sign out"
      And the screen is the "sign-out" form
      When they press "Sign out"
      Then they are asked to sign in
      And they see the note "You signed out just now."
      When they reload the page
      Then they are asked to sign in
      And no note is shown

    Scenario: Cancelling keeps the session
      When they open the dashboard at "/account"
      And they follow "Sign out"
      And they cancel
      Then they see the page "Organizations"
      When they reload the page
      Then they see the page "Organizations"

  Rule: A personal token signs its owner in

    Scenario: Signing in with a personal token
      Given Ada has a personal token "laptop"
      And a visitor who is not signed in
      When they open the dashboard at "/account"
      And they sign in with the personal token "laptop"
      Then they see the page "Account"
      And they see the email of Ada

    Scenario: A token that was never issued is refused under the token field
      Given a visitor who is not signed in
      When they open the dashboard
      And they sign in with the made-up token "mbf_u_never-issued"
      Then the field "Personal token" says "Malformed API key"
      And they see the page "Sign in with a token"

    Scenario: An organization key cannot be used to sign in
      Given Ada owns an organization "Acme"
      And Ada has an organization key "ci" for "Acme" with the member role
      And a visitor who is not signed in
      When they open the dashboard
      And they sign in with the personal token "ci"
      Then the field "Personal token" says "Sign in with a personal token (mbf_u_…), not an organization key"
      And they see the page "Sign in with a token"

    Scenario: An empty token is asked for before anything is sent
      Given a visitor who is not signed in
      When they open the dashboard
      And they choose to "Sign in with a token"
      And they press "Sign in"
      Then the field "Personal token" says "Paste your personal token."

    Scenario: A second refusal replaces the first
      Given a visitor who is not signed in
      When they open the dashboard
      And they sign in with the made-up token "mbf_u_first"
      And they sign in with the made-up token "mbf_u_second"
      Then exactly 1 problem is pointed out

  Rule: Too many attempts from one address are refused with an explanation

    Scenario: A visitor who keeps trying is told to stop, in the form
      Given the server is configured with:
        | RATE_LIMIT_AUTH_PER_MINUTE | 1 |
      And a visitor who is not signed in
      When they open the dashboard
      And they sign in with the made-up token "mbf_u_first"
      And they cancel
      And they sign in locally as Ada
      Then the form says "You were not signed in."
      And the form says "Too many sign-in attempts from this address."
      And no field is marked wrong
      And they see the page "Sign in locally"

  Rule: Single sign-on goes through the identity provider's own pages

    Background:
      Given a dashboard that signs people in through an OpenID Connect provider
      And the provider has an account for Ada
      And a visitor who is not signed in

    Scenario: The sign-in screen offers single sign-on
      When they open the dashboard
      Then they are asked to sign in
      And they are offered to "Continue with single sign-on"

    Scenario: Signing in at the provider opens the dashboard
      When they open the dashboard
      And they choose to "Continue with single sign-on"
      And they choose the account of Ada at the provider and allow access
      Then they see the page "Organizations"
      When they follow "Account"
      Then they see the email of Ada

    Scenario: Single sign-on returns the visitor to the page they asked for
      When they open the dashboard at "/api-reference"
      And they choose to "Continue with single sign-on"
      And they choose the account of Ada at the provider and allow access
      Then they see the page "API reference"
      And the address is "/api-reference"

    Scenario: Cancelling at the provider signs nobody in
      When they open the dashboard
      And they choose to "Continue with single sign-on"
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
      And there is a link "Try again"
      When the server starts again
      And they follow "Try again"
      Then they see the page "API reference"

    Scenario: Being rate limited is explained instead of leaving the page loading
      Given the server is configured with:
        | RATE_LIMIT_API_PER_MINUTE | 4 |
      And Ada is signed in to the dashboard
      When they open the dashboard at "/account"
      And they reload the page until the server refuses
      Then they see the page "Mockingbird Fleet is not responding"
      And they see "Too many API requests."
