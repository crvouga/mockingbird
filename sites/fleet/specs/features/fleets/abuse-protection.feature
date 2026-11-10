@fleets @abuse
Feature: Protection against abuse of a fleet
  The URL of an open fleet is all a stranger needs to call it, so nothing a stranger can send
  may wipe the fleet, stall it, hold its connections open or make the service call out to
  somewhere else.

  Rule: Emulator control headers are honoured only with a key that may change things

    Emulators accept per-request control headers that reset them, inject faults, move their
    clock or delay an answer. Choosing a namespace is harmless and always allowed.

    Background:
      Given Ada has an open fleet "Staging" with a strict Resend emulator
      And an SDK has sent an email through "Staging"

    Scenario Outline: A reset header from <caller> is ignored
      When a caller presenting <credential> reads the email back with the header "x-mockingbird-reset: 1"
      Then the response status is 200
      And the email is still there

      Examples:
        | caller          | credential   |
        | a stranger      | no key       |
        | a read-only key | a viewer key |

    Scenario: A reset header with a member key resets the emulator
      When a caller presenting a member key reads the email back with the header "x-mockingbird-reset: 1"
      Then the email is gone

    Scenario Outline: A fault header from <caller> is ignored
      When a caller presenting <credential> reads the email back with the header "x-mockingbird-fault: 503"
      Then the response status is 200

      Examples:
        | caller          | credential   |
        | a stranger      | no key       |
        | a read-only key | a viewer key |

    Scenario: A fault header with a member key makes the emulator fail that request
      When a caller presenting a member key reads the email back with the header "x-mockingbird-fault: 503"
      Then the response status is 503

    Scenario: A clock header from a stranger does not move the emulator's clock
      When an SDK sends an email through "Staging" with the header "x-mockingbird-time: 2030-01-01T00:00:00Z"
      Then the email is not dated in 2030

    Scenario: A clock header with a member key moves the emulator's clock
      When an SDK presenting a member key sends an email through "Staging" with the header "x-mockingbird-time: 2030-01-01T00:00:00Z"
      Then the email is dated in 2030

  Rule: A request that runs too long is cut off

    Background:
      Given the server is configured with:
        | FLEET_REQUEST_TIMEOUT_MS | 3000 |
      And Ada has an open fleet "Staging" with a buffered Resend emulator
      And an SDK has sent an email through "Staging"

    Scenario: A stranger cannot make an emulator slow
      When a caller presenting no key reads the email back with the header "x-mockingbird-delay: 12000ms"
      Then the response status is 200

    Scenario: A request slowed down with a member key is answered 504 at the timeout
      When a caller presenting a member key reads the email back with the header "x-mockingbird-delay: 12000ms"
      Then the response status is 504
      And the request is refused as "emulator_timeout"
      And the message says "did not answer within 3000 ms"

    Scenario: The fleet keeps serving after a request timed out
      When a caller presenting a member key reads the email back with the header "x-mockingbird-delay: 12000ms"
      Then the email can be read back

  Rule: A fleet serves a bounded number of requests at once

    Background:
      Given the server is configured with:
        | FLEET_MAX_CONCURRENT_REQUESTS | 2 |
      And Ada has an open fleet "Staging" with an ephemeral Resend emulator

    Scenario: Requests beyond the cap are refused and told to retry shortly
      When 5 slow requests reach "Staging" at the same moment
      Then 2 of them are served
      And 3 of them are refused as "too_many_concurrent_requests" with a time to retry

    Scenario: The fleet serves again once the slow requests have finished
      When 5 slow requests reach "Staging" at the same moment
      And an SDK sends an email through "Staging"
      Then the email is accepted

    Scenario: A busy fleet does not hold up another fleet
      Given Ada has an open fleet "Preview" with an ephemeral Resend emulator
      When an SDK sends an email through "Preview" while 2 slow requests occupy "Staging"
      Then the email is accepted

  Rule: Emulators make no outbound requests unless public https origins are allowed

    # Delivery to an allowed origin needs a receiver on the public internet, which a spec run
    # does not have. What is specified here is what the service refuses, and that refusing a
    # delivery never costs the emulator its state.

    Scenario: By default a registered webhook is never delivered
      Given Ada has an open fleet "Staging" with these emulators:
        | name    | target | durability |
        | billing | stripe | strict     |
      And a webhook receiver is listening on this machine
      And the "billing" emulator of "Staging" has the receiver registered as a webhook endpoint
      When a Stripe SDK creates a customer through the "billing" emulator of "Staging"
      Then the request succeeds
      And the "billing" emulator of "Staging" records the delivery as refused because "delivery disabled"
      And the receiver has heard nothing

    Scenario: An emulator whose webhooks are refused still stores its state
      Given a deployment of its own for this scenario
      And Ada has an open fleet "Staging" with these emulators:
        | name    | target | durability |
        | billing | stripe | strict     |
      And a webhook receiver is listening on this machine
      And the "billing" emulator of "Staging" has the receiver registered as a webhook endpoint
      When a Stripe SDK creates a customer through the "billing" emulator of "Staging"
      And the server is killed without warning and started again
      Then the customer is still there

    Scenario: With allowed origins, a destination that is not on the list is still refused
      Given Ada has an open fleet "Staging" with these emulators:
        | name    | target | durability |
        | billing | stripe | strict     |
      And Ada allows the "billing" emulator of "Staging" to deliver webhooks to "https://hooks.example.com"
      And a webhook receiver is listening on this machine
      And the "billing" emulator of "Staging" has the receiver registered as a webhook endpoint
      When a Stripe SDK creates a customer through the "billing" emulator of "Staging"
      Then the "billing" emulator of "Staging" records the delivery as refused because "destination not allowed"
      And the receiver has heard nothing

    Scenario Outline: "<origin>" cannot be allowed as a webhook origin because <why>
      Given Ada has an open fleet "Staging" with a buffered Resend emulator
      When Ada allows the "resend" emulator of "Staging" to deliver webhooks to "<origin>"
      Then the response status is 400
      And the message says "must be a public https origin"

      Examples:
        | origin                       | why                              |
        | http://app.example.com       | it is not https                  |
        | https://localhost            | it is this machine               |
        | https://127.0.0.1            | it is a loopback address         |
        | https://10.0.0.5             | it is a private network address  |
        | https://db.internal          | it is an internal name           |
        | https://intranet             | it is not a public name          |
        | https://app.example.com/hook | it is a URL, not an origin       |

    Scenario: A public https origin can be allowed
      Given Ada has an open fleet "Staging" with a buffered Resend emulator
      When Ada allows the "resend" emulator of "Staging" to deliver webhooks to "https://app.example.com"
      Then the request succeeds

  Rule: Request bodies are capped

    Scenario: An emulator call with a body over 32 MiB is refused
      Given Ada has an open fleet "Staging" with an ephemeral Resend emulator
      When an SDK sends a 33 MiB body to "Staging"
      Then the response status is 413

    Scenario: A control API call with a body over 1 MiB is refused
      Given Ada is known to the service
      When Ada sends a 2 MiB body to the control API
      Then the response status is 413
      And the request is refused as "body_too_large"
