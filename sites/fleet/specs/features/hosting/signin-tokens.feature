@hosting @signin
Feature: Signing in without an identity provider
  A self-hoster needs no identity provider. With OPERATOR_TOKEN set, the operator creates users
  over the API; each gets a personal token that works as an API credential and can be exchanged
  for a browser session. Typing an email to sign in (dev login) exists only on localhost.

  Scenario: The operator creates a user and receives a personal token for them
    When the operator creates the user "grace@example.test" named "Grace Hopper"
    Then the response status is 201
    And the reply holds the user "grace@example.test" named "Grace Hopper"
    And the reply holds a personal token starting with "mbf_u_"
    And the reply says where to sign in
    And the personal token works as an API credential for "grace@example.test"

  Scenario: A personal token is exchanged for a browser session
    Given the operator has issued a personal token to "grace@example.test"
    When that personal token is exchanged at "/auth/token-login"
    Then the response status is 200
    And the exchange sets a session cookie that scripts cannot read and other sites cannot send
    And that session cookie signs in "grace@example.test"

  Scenario: Creating the same user again issues another token for the same person
    Given the operator has issued a personal token to "grace@example.test"
    When the operator creates the user "Grace@Example.test" named "Grace"
    Then the response status is 201
    And both issued tokens belong to the same user

  Scenario Outline: Only a valid personal token can be exchanged: <credential>
    Given the operator has issued a personal token to "grace@example.test"
    When <credential> is exchanged at "/auth/token-login"
    Then the response status is <status>
    And the message says "<message>"
    And the exchange sets no session cookie

    Examples:
      | credential                              | status | message                                                         |
      | an organization API key                 | 401    | Sign in with a personal token (mbf_u_…), not an organization key |
      | a personal token nobody was issued      | 401    | Unknown or expired API key                                      |
      | the operator token                      | 401    | Malformed API key                                               |
      | nothing                                 | 400    | token is required                                               |

  Scenario: The exchange refuses requests a browser could be tricked into sending
    Given the operator has issued a personal token to "grace@example.test"
    When that personal token is exchanged at "/auth/token-login" without the CSRF header
    Then the response status is 403
    And the exchange sets no session cookie

  Scenario Outline: Only the operator can create users: <caller>
    When <caller> tries to create the user "eve@example.test"
    Then the response status is <status>
    And the request is refused as "<code>"

    Examples:
      | caller                             | status | code         |
      | a caller with no credential        | 401    | unauthorized |
      | a caller with a wrong operator token | 401  | unauthorized |
      | a signed-in user                   | 401    | unauthorized |

  Scenario: Without OPERATOR_TOKEN nobody can create users
    Given the server is configured with:
      | OPERATOR_TOKEN |  |
    When a caller presenting the usual operator token tries to create the user "eve@example.test"
    Then the response status is 404
    And the request is refused as "operator_api_disabled"
    And the message says "Set OPERATOR_TOKEN (32+ characters) on the server to enable it"

  Scenario: An invalid email address is not a user
    When the operator creates the user "not-an-email" named "Nobody"
    Then the response status is 400
    And the request is refused as "invalid_request"

  Scenario: On localhost dev login signs in whoever types an email
    When a visitor signs in with dev login as "linus@example.test"
    Then the response status is 200
    And that session cookie signs in "linus@example.test"

  Scenario: Dev login is off unless it is turned on, even on localhost
    Given the server is configured with:
      | AUTH_DEV_LOGIN |  |
    When a visitor signs in with dev login as "linus@example.test"
    Then the response status is 404
    And the exchange sets no session cookie

  Scenario: Dev login cannot be turned on for a public address
    Given a complete production configuration
    And the configuration sets "AUTH_DEV_LOGIN" to "1"
    When the server process is started
    Then the server refuses to start
    And the startup report says "Dev login lets anyone sign in as any email address with no password"

  Scenario: OpenID Connect sign-in does not exist until it is configured
    When a visitor tries to start signing in
    Then the sign-in attempt is refused with status 404 as "not_found"
