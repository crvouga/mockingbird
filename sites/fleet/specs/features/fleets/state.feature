@fleets @durability @state
Feature: Managing an emulator's stored state
  A member can save an emulator's state on demand, download it, return the emulator to its boot
  state, and remove it. Whatever is removed in the dashboard is removed from object storage,
  and nothing is ever written outside the configured prefix.

  Rule: Saving on demand

    Background:
      Given Ada has an open fleet "Staging" with a buffered Resend emulator
      And the emulator of "Staging" saves buffered changes every 60000 ms
      And an SDK has sent an email through "Staging"

    Scenario: An emulator with unsaved changes says so
      Then the emulator of "Staging" reports unsaved changes

    Scenario: Flushing saves a buffered emulator's unsaved state immediately
      When Ada asks the emulator of "Staging" to save its state now
      Then the request succeeds
      And object storage already holds the email
      And the emulator of "Staging" reports its state as saved

  Rule: Downloading state

    Scenario: The exported state is a portable document holding what the emulator holds
      Given Ada has an open fleet "Staging" with a buffered Resend emulator
      And an SDK has sent an email through "Staging"
      When Ada downloads the state of the emulator of "Staging"
      Then the request succeeds
      And the state document is for the "resend" emulator
      And the state document holds the email in the namespace "default"

    Scenario: The exported state covers every namespace
      Given Ada has an open fleet "Staging" with a strict Resend emulator
      And an SDK has sent an email through "Staging" in the namespace "run-1"
      When Ada downloads the state of the emulator of "Staging"
      Then the state document holds the email in the namespace "run-1"
      And the state document has a namespace "default" without the email

  Rule: Resetting

    Scenario Outline: Resetting a <durability> emulator returns it to its boot state
      Given Ada has an open fleet "Staging" with a <durability> Resend emulator
      And an SDK has sent an email through "Staging"
      When Ada resets the emulator of "Staging"
      Then the request succeeds
      And object storage holds nothing for "Staging"
      And the email is gone

      Examples:
        | durability |
        | strict     |
        | buffered   |
        | ephemeral  |

    Scenario: A reset emulator keeps working
      Given Ada has an open fleet "Staging" with a strict Resend emulator
      And an SDK has sent an email through "Staging"
      When Ada resets the emulator of "Staging"
      And an SDK sends an email through "Staging"
      Then the email is accepted
      And object storage already holds the email

    Scenario: A reset is seen by every replica
      Given a deployment of its own for this scenario
      And a second replica is running
      And Ada has an open fleet "Staging" with a strict Resend emulator
      And an SDK has sent an email through "Staging"
      And the email can be read back through the second replica
      When Ada resets the emulator of "Staging"
      Then the email cannot be read back through the second replica

  Rule: Removing an emulator or a fleet removes what was stored for it

    Background:
      Given Ada has an open fleet "Staging" with these emulators:
        | name     | target | durability |
        | mail     | resend | strict     |
        | receipts | resend | strict     |
      And an SDK has sent an email through the "receipts" emulator of "Staging"
      And an SDK has sent an email through the "mail" emulator of "Staging"

    Scenario: Deleting an emulator removes its stored state and its URL
      When Ada deletes the "mail" emulator of "Staging"
      Then object storage holds nothing for the "mail" emulator of "Staging"
      But object storage holds state for the "receipts" emulator of "Staging"
      And the "mail" emulator of "Staging" is no longer found

    Scenario: Deleting a fleet removes all of its stored state and its URL
      When Ada deletes the fleet "Staging"
      Then object storage holds nothing for "Staging"
      And the fleet "Staging" is no longer found

    Scenario: Deleting the organization removes the stored state of all its fleets
      When Ada deletes her organization
      Then object storage holds nothing for "Staging"

    Scenario: Replacing an emulator with a different one starts clean
      When Ada replaces the "mail" emulator of "Staging" with a Stripe emulator
      Then object storage holds nothing for the "mail" emulator of "Staging"
      And a Stripe SDK can create a customer through the "mail" emulator of "Staging"

    Scenario: The old state does not return when the original emulator is put back
      When Ada replaces the "mail" emulator of "Staging" with a Stripe emulator
      And Ada replaces the "mail" emulator of "Staging" with a Resend emulator
      Then the email is gone

    Scenario: Reconfiguring an emulator without changing what it emulates keeps its state
      When Ada replaces the "mail" emulator of "Staging" with a Resend emulator
      Then the email is still there

  Rule: Nothing is written outside the configured prefix

    Scenario: Every stored object is under the configured prefix
      Given the server is configured with:
        | S3_PREFIX | tenants/spec-area |
      And Ada has an open fleet "Staging" with these emulators:
        | name    | target | durability |
        | mail    | resend | strict     |
        | notes   | resend | buffered   |
        | billing | stripe | strict     |
      When an SDK sends an email through the "mail" emulator of "Staging"
      And an SDK sends an email through the "notes" emulator of "Staging"
      And a Stripe SDK creates a customer through the "billing" emulator of "Staging"
      And Ada asks the "notes" emulator of "Staging" to save its state now
      Then every object in the bucket is under "tenants/spec-area/fleets/"
      And object storage holds one object for each emulator of "Staging"

    Scenario: Removing everything leaves the bucket empty
      Given the server is configured with:
        | S3_PREFIX | tenants/spec-area |
      And Ada has an open fleet "Staging" with a strict Resend emulator
      And an SDK has sent an email through "Staging"
      When Ada deletes the fleet "Staging"
      Then the bucket is empty
