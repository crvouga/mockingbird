@fleets @limits @rate-limits
Feature: Rate limits
  Four budgets protect the service, each refilling steadily over a minute: one per credential on
  the control API, one per client address for sign-in attempts and rejected credentials, one per
  client address for emulator calls, and one per fleet. A refusal says how long to wait and how
  large the budget is.

  Rule: The control API is limited per credential

    Background:
      Given the server is configured with:
        | RATE_LIMIT_API_PER_MINUTE | 10 |
        | TRUSTED_PROXY_HOPS        | 1  |

    Scenario: A credential that uses up its budget is refused and told when to retry
      When Ada calls the control API until she is refused
      Then the response status is 429
      And the request is refused as "rate_limited"
      And the refusal reports a budget of 10 per minute with nothing remaining
      And the refusal says how many seconds to wait

    Scenario: Each credential has a budget of its own
      Given Grace is known to the service
      When Ada calls the control API until she is refused
      Then Grace is still served by the control API

    Scenario: Answers report how much of the budget remains
      When Ada calls the control API once
      Then the answer reports a budget of 10 per minute and how much remains

    Scenario: Callers without a credential share a budget per client address
      When an anonymous caller at "198.51.100.7" calls the control API until refused
      Then the request is refused as "rate_limited"
      But an anonymous caller at "198.51.100.8" is still served by the control API

  Rule: Sign-in attempts and rejected credentials are limited per client address

    Background:
      Given the server is configured with:
        | RATE_LIMIT_AUTH_PER_MINUTE | 5 |
        | TRUSTED_PROXY_HOPS         | 1 |

    Scenario: Too many sign-in attempts from one address are refused
      When someone at "198.51.100.7" attempts to sign in until refused
      Then the response status is 429
      And the request is refused as "auth_rate_limited"
      And the refusal reports a budget of 5 per minute with nothing remaining
      And the refusal says how many seconds to wait
      But someone at "198.51.100.8" can sign in

    Scenario: After too many rejected credentials, an address is refused even with a valid one
      Given Ada is known to the service
      When someone at "198.51.100.7" presents rejected credentials to the control API until refused
      Then the request is refused as "auth_rate_limited"
      And even Ada's valid credential is refused as "auth_rate_limited" from "198.51.100.7"
      But Ada is still served by the control API from "198.51.100.8"

    Scenario: Rejected keys on emulator calls count against the address too
      Given Ada has a key-protected fleet "Staging" with an ephemeral Resend emulator
      When an SDK at "198.51.100.7" presents rejected keys to "Staging" until refused
      Then the request is refused as "auth_rate_limited"
      And even a member key for "Staging" is refused as "auth_rate_limited" from "198.51.100.7"

    Scenario: Accepted credentials cost nothing
      Given Ada is known to the service
      When Ada calls the control API 20 times from "198.51.100.7"
      Then every one of them is accepted

  Rule: Emulator calls are limited per client address

    Scenario Outline: Behind <hops> trusted proxies, a client forwarded as "<chain>" is counted by the address the outermost proxy saw
      Given the server is configured with:
        | RATE_LIMIT_CLIENT_PER_MINUTE | 6      |
        | TRUSTED_PROXY_HOPS           | <hops> |
      And Ada has an open fleet "Staging" with an ephemeral Resend emulator
      When an SDK whose forwarding chain is "<chain>" calls "Staging" until refused
      Then the response status is 429
      And the request is refused as "rate_limited"
      And the refusal reports a budget of 6 per minute with nothing remaining
      And the refusal says how many seconds to wait
      And an SDK whose forwarding chain is "<same client, another claim>" is refused by "Staging"
      But an SDK whose forwarding chain is "<another client>" is served by "Staging"

      Examples:
        | hops | chain                  | same client, another claim           | another client         |
        | 1    | 198.51.100.7           | 203.0.113.99, 198.51.100.7           | 198.51.100.8           |
        | 1    | 10.1.1.1, 198.51.100.7 | 10.2.2.2, 198.51.100.7               | 10.1.1.1, 198.51.100.8 |
        | 2    | 198.51.100.7, 10.0.0.1 | 203.0.113.99, 198.51.100.7, 10.0.0.1 | 198.51.100.8, 10.0.0.1 |

    Scenario: Without trusted proxies, a forwarding header buys no fresh budget
      Given the server is configured with:
        | RATE_LIMIT_CLIENT_PER_MINUTE | 6 |
        | TRUSTED_PROXY_HOPS           | 0 |
      And Ada has an open fleet "Staging" with an ephemeral Resend emulator
      When an SDK calls "Staging" until refused
      Then the request is refused as "rate_limited"
      And an SDK whose forwarding chain is "203.0.113.99" is refused by "Staging"

    Scenario: One address's budget covers every fleet it calls
      Given the server is configured with:
        | RATE_LIMIT_CLIENT_PER_MINUTE | 6 |
        | TRUSTED_PROXY_HOPS           | 1 |
      And Ada has an open fleet "Staging" with an ephemeral Resend emulator
      And Grace has an open fleet "Preview" with an ephemeral Resend emulator
      When an SDK whose forwarding chain is "198.51.100.7" calls "Staging" until refused
      Then an SDK whose forwarding chain is "198.51.100.7" is refused by "Preview"

  Rule: Each fleet has a budget, with a ceiling set by the service

    Background:
      Given the server is configured with:
        | LIMIT_FLEET_REQUESTS_PER_MINUTE | 12 |
      And Ada has an open fleet "Staging" with an ephemeral Resend emulator

    Scenario: A fleet that uses up its budget is refused, whoever is calling
      When an SDK calls "Staging" until refused
      Then the response status is 429
      And the request is refused as "fleet_rate_limited"
      And the refusal reports a budget of 12 per minute with nothing remaining
      And the refusal says how many seconds to wait

    Scenario: Another fleet has its own budget
      Given Ada has an open fleet "Preview" with an ephemeral Resend emulator
      When an SDK calls "Staging" until refused
      And an SDK sends an email through "Preview"
      Then the email is accepted

    Scenario: Emulator answers report how much of the fleet's budget remains
      When an SDK sends an email through "Staging"
      Then the answer reports a budget of 12 per minute and how much remains

    Scenario: A fleet may lower its own budget
      When Ada sets the budget of "Staging" to 6 requests per minute
      Then the request succeeds
      When an SDK calls "Staging" until refused
      Then the refusal reports a budget of 6 per minute with nothing remaining

    Scenario: A fleet may not raise its budget past the ceiling
      When Ada sets the budget of "Staging" to 13 requests per minute
      Then the response status is 400
      And the message says "cannot exceed this organization's ceiling of 12"

    Scenario: A new fleet may not ask for more than the ceiling either
      When Ada tries to create a fleet with a budget of 500 requests per minute
      Then the response status is 400
      And the message says "cannot exceed this organization's ceiling of 12"

  Rule: Every budget refills steadily, so a caller who waits as asked is served again

    Scenario: The control API budget refills
      Given the server is configured with:
        | RATE_LIMIT_API_PER_MINUTE | 60 |
      When Ada calls the control API until she is refused
      And the caller waits as long as the refusal asked
      Then Ada is still served by the control API

    Scenario: The sign-in lockout lifts
      Given the server is configured with:
        | RATE_LIMIT_AUTH_PER_MINUTE | 60 |
        | TRUSTED_PROXY_HOPS         | 1  |
      When someone at "198.51.100.7" attempts to sign in until refused
      And the caller waits as long as the refusal asked
      Then someone at "198.51.100.7" can sign in

    Scenario: A client address's emulator budget refills
      Given the server is configured with:
        | RATE_LIMIT_CLIENT_PER_MINUTE | 60 |
        | TRUSTED_PROXY_HOPS           | 1  |
      And Ada has an open fleet "Staging" with an ephemeral Resend emulator
      When an SDK whose forwarding chain is "198.51.100.7" calls "Staging" until refused
      And the caller waits as long as the refusal asked
      Then an SDK whose forwarding chain is "198.51.100.7" is served by "Staging"

    Scenario: A fleet's budget refills
      Given the server is configured with:
        | LIMIT_FLEET_REQUESTS_PER_MINUTE | 60 |
      And Ada has an open fleet "Staging" with an ephemeral Resend emulator
      When an SDK calls "Staging" until refused
      And the caller waits as long as the refusal asked
      And an SDK sends an email through "Staging"
      Then the email is accepted
