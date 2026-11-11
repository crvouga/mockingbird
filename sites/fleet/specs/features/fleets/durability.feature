@fleets @durability
Feature: Durability, chosen per emulator
  Every emulator in a fleet chooses how much of its state survives. "strict" answers only once
  the change is in object storage, "buffered" answers from memory and saves shortly afterwards,
  and "ephemeral" keeps state in memory only. The server itself holds nothing that matters:
  any replica can serve any emulator from what is stored.

  Background:
    Given a deployment of its own for this scenario

  Rule: strict loses nothing it has acknowledged

    Background:
      Given Ada has an open fleet "Staging" with a strict Resend emulator

    Scenario: The state is in object storage before the SDK gets its answer
      When an SDK sends an email through "Staging"
      Then object storage already holds the email

    Scenario: The state is visible to another replica immediately
      Given a second replica is running
      When an SDK sends an email through "Staging"
      Then the email can be read back through the second replica

    Scenario: Two replicas taking turns lose nothing
      Given a second replica is running
      When SDKs send 6 emails through "Staging", taking turns between the two replicas
      Then every one of the 6 emails can be read back through either replica

    Scenario: Two replicas written to at the same moment lose nothing
      Given a second replica is running
      When SDKs send 6 emails through "Staging", to both replicas at the same moment
      Then every one of the 6 emails can be read back through either replica

  Rule: What survives the server stopping depends on the mode

    Scenario Outline: With <durability> durability the email is <outcome> after the server is <stopped>
      Given Ada has an open fleet "Staging" with a <durability> Resend emulator
      And the emulator of "Staging" saves buffered changes every 60000 ms
      When an SDK sends an email through "Staging"
      And the server is <stopped> and started again
      Then the email is <outcome>

      Examples:
        | durability | stopped                | outcome     |
        | strict     | killed without warning | still there |
        | strict     | shut down gracefully   | still there |
        | buffered   | killed without warning | gone        |
        | buffered   | shut down gracefully   | still there |
        | ephemeral  | killed without warning | gone        |
        | ephemeral  | shut down gracefully   | gone        |

  Rule: buffered answers first and saves soon after

    Scenario: A buffered emulator answers before anything is saved
      Given Ada has an open fleet "Staging" with a buffered Resend emulator
      And the emulator of "Staging" saves buffered changes every 60000 ms
      When an SDK sends an email through "Staging"
      Then the email is accepted
      And object storage holds nothing for "Staging"

    Scenario: A buffered emulator saves within its flush interval
      Given Ada has an open fleet "Staging" with a buffered Resend emulator
      And the emulator of "Staging" saves buffered changes every 300 ms
      When an SDK sends an email through "Staging"
      Then within 10 seconds object storage holds the email

    Scenario: Without a flush interval of its own, a buffered emulator saves within a few seconds
      Given Ada has an open fleet "Staging" with a buffered Resend emulator
      When an SDK sends an email through "Staging"
      Then within 15 seconds object storage holds the email

    Scenario: An emulator is buffered unless it says otherwise
      Given Ada has an open fleet "Staging" with a Resend emulator of unstated durability
      Then the emulator of "Staging" is "buffered"

  Rule: ephemeral is never stored

    Scenario: An ephemeral emulator stores nothing, even when asked to save
      Given Ada has an open fleet "Staging" with an ephemeral Resend emulator
      When an SDK sends an email through "Staging"
      And Ada asks the emulator of "Staging" to save its state now
      Then the request succeeds
      And object storage holds nothing for "Staging"
      But the email can be read back

  Rule: Changing an emulator's durability takes effect at once

    Scenario: Switching to ephemeral deletes the stored copy
      Given Ada has an open fleet "Staging" with a strict Resend emulator
      And an SDK has sent an email through "Staging"
      When Ada changes the emulator of "Staging" to ephemeral durability
      Then object storage holds nothing for "Staging"
      But the email can be read back

    Scenario: A deleted copy does not come back after a restart
      Given Ada has an open fleet "Staging" with a strict Resend emulator
      And an SDK has sent an email through "Staging"
      When Ada changes the emulator of "Staging" to ephemeral durability
      And the server is shut down gracefully and started again
      Then the email is gone

    Scenario: Switching back from ephemeral stores the state again
      Given Ada has an open fleet "Staging" with an ephemeral Resend emulator
      And an SDK has sent an email through "Staging"
      When Ada changes the emulator of "Staging" to strict durability
      Then object storage already holds the email

    Scenario: Switching from buffered to strict saves what was still unsaved
      Given Ada has an open fleet "Staging" with a buffered Resend emulator
      And the emulator of "Staging" saves buffered changes every 60000 ms
      And an SDK has sent an email through "Staging"
      When Ada changes the emulator of "Staging" to strict durability
      Then object storage already holds the email

    Scenario: After switching to strict, the next change is stored before it is answered
      Given Ada has an open fleet "Staging" with an ephemeral Resend emulator
      When Ada changes the emulator of "Staging" to strict durability
      And an SDK sends an email through "Staging"
      Then object storage already holds the email
