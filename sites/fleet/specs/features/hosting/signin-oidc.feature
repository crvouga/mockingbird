@hosting @signin
Feature: Signing in through an OpenID Connect provider
  With OIDC_ISSUER and OIDC_CLIENT_ID set, people sign in at the operator's identity provider.
  The server is a public client: authorization code with S256 PKCE and no client secret. A
  person is identified by the provider and their subject there, never by an email address, and
  a sign-in link works exactly once, for the browser attempt that started it.

  Background:
    Given a server that signs people in through an OpenID Connect provider
    And the provider has an account "ada" with the email "ada@example.test"

  Scenario: Starting a sign-in sends the browser to the provider as a public client with PKCE
    When a visitor starts to sign in
    Then the visitor is redirected to the provider's authorization endpoint
    And the authorization request carries:
      | response_type         | code                 |
      | scope                 | openid email profile |
      | code_challenge_method | S256                 |
    And the authorization request names this server's client id and its "/auth/callback" address
    And the authorization request has a code challenge, a state and a nonce
    And the authorization request carries no client secret

  Scenario: Every sign-in attempt gets its own state, nonce and code challenge
    When a visitor starts to sign in
    And a visitor starts to sign in
    Then the two authorization requests share no state, nonce or code challenge

  Scenario: Finishing the sign-in starts a session and returns to the page that was asked for
    When "ada" signs in at the provider, asking to return to "/orgs/org_123?tab=keys"
    Then the sign-in ends with a redirect to "/orgs/org_123?tab=keys"
    And the sign-in sets a session cookie that scripts cannot read and other sites cannot send
    And the new session belongs to "ada@example.test"

  Scenario Outline: A return address outside this site is ignored: <return to>
    When "ada" signs in at the provider, asking to return to "<return to>"
    Then the sign-in ends with a redirect to "/"
    And the new session belongs to "ada@example.test"

    Examples:
      | return to                 |
      | https://evil.example/     |
      | //evil.example/phish      |
      | /\\evil.example           |
      | javascript:alert(1)       |
      | orgs/relative             |

  Scenario: Without a return address the sign-in lands on the home page
    When "ada" signs in at the provider
    Then the sign-in ends with a redirect to "/"

  Scenario: A sign-in link cannot be used twice
    Given "ada" signs in at the provider
    When the same callback address is opened again
    Then the callback is refused with status 400
    And the callback says "This sign-in link was already used or has expired"
    And the callback starts no session

  Scenario Outline: A callback that does not belong to a sign-in this server started is refused: <case>
    Given "ada" approves a sign-in at the provider
    When the callback is opened with <change>
    Then the callback is refused with status 400
    And the callback says "<message>"
    And the callback starts no session

    Examples:
      | case           | change           | message                                           |
      | unknown state  | a made-up state  | This sign-in link was already used or has expired |
      | missing state  | no state         | Sign-in was not completed                         |
      | missing code   | no code          | Sign-in was not completed                         |
      | made-up code   | a made-up code   | The identity provider rejected the sign-in        |

  Scenario: A code from one sign-in attempt cannot finish another
    Given "ada" approves a sign-in at the provider
    And "ada" approves a second sign-in at the provider
    When the callback of the first attempt is opened with the code of the second
    Then the callback is refused with status 400
    And the callback says "The identity provider rejected the sign-in"
    And the callback starts no session

  Scenario: Declining at the provider starts no session
    When "ada" declines the sign-in at the provider
    Then the callback is refused with status 400
    And the callback says "access_denied"
    And the callback starts no session

  Scenario: Two people at the provider who share an email address are two users
    Given "ada" signs in at the provider
    And "ada" creates an organization "Analytical Engines" in that session
    And the provider reassigns the email "ada@example.test" from "ada" to a new account "mallory"
    When "mallory" signs in at the provider
    Then the new session belongs to "ada@example.test"
    But the sessions of "ada" and "mallory" belong to different users
    And the session of "mallory" sees no organizations

  Scenario: The same person signing in again is the same user, with their profile refreshed
    Given "ada" signs in at the provider
    And "ada" creates an organization "Analytical Engines" in that session
    And the provider changes the email of "ada" to "countess@example.test"
    When "ada" signs in at the provider
    Then the new session belongs to "countess@example.test"
    And both sessions of "ada" belong to the same user
    And the session of "ada" sees the organization "Analytical Engines"

  Scenario Outline: An ID token that cannot be verified starts no session: <case>
    Given the provider <fault>
    When "ada" signs in at the provider
    Then the callback is refused with status 400
    And the callback says "The identity provider's token could not be verified"
    And the callback starts no session

    Examples:
      | case                     | fault                                          |
      | signed by an unknown key | signs ID tokens with a key it does not publish |
      | already expired          | issues ID tokens that expired an hour ago      |

  Scenario: Signing out ends the session
    Given "ada" signs in at the provider
    When "ada" signs out of the server
    Then the session of "ada" is no longer accepted

  Scenario: Any replica can finish a sign-in that another replica started
    Given a second replica of the server behind the same public address
    And "ada" approves a sign-in at the provider
    When the callback is opened on the second replica
    Then the sign-in ends with a redirect to "/"
    And the new session belongs to "ada@example.test"

  Scenario: The provider being down is reported as such, not as a broken page
    Given the provider is not running
    When a visitor tries to start signing in
    Then the sign-in attempt is refused with status 503 as "identity_provider_unavailable"
