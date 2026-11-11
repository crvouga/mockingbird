@dashboard
Feature: The emulators of a fleet in the dashboard
  Each emulator of a fleet has a card on the fleet's page: its address, its durability and where
  its stored state stands. An emulator is added in two steps: finding it in the catalog, then
  naming it and choosing its durability on a form. Changing its durability, saving it now,
  resetting it and removing it each happen on a screen of its own, reached from its card. Only
  downloading its state happens on the card itself, because it changes nothing.

  Background:
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"
    And Ada has a project "Web app" in "Acme"

  Rule: An emulator is found in the catalog

    Background:
      Given Ada has a fleet "Staging" in the project "Web app"

    Scenario: The catalog lists every emulator
      When they open the fleet "Staging"
      And they follow "Add an emulator"
      Then they see the page "Add an emulator to Staging"
      And the search offers every emulator of the catalog

    Scenario: Searching narrows the catalog
      When they open the address of the fleet "Staging" followed by "/add-emulator"
      And they type "stripe" into "Search emulators"
      Then the search offers "Stripe"
      And the search does not offer "Airtable"

    Scenario: A search can match a category
      When they open the address of the fleet "Staging" followed by "/add-emulator"
      And they type "payments" into "Search emulators"
      Then the search offers "Stripe"

    Scenario: A search that matches nothing says so
      When they open the address of the fleet "Staging" followed by "/add-emulator"
      And they type "mainframe" into "Search emulators"
      Then they see "No emulator matches “mainframe”"
      And they see "Search by vendor or category, for example stripe, email or storage."

    Scenario: The search is kept in the address, so a reload shows the same results
      When they open the address of the fleet "Staging" followed by "/add-emulator"
      And they type "stripe" into "Search emulators"
      And they reload the page
      Then the field "Search emulators" holds "stripe"
      And the search offers "Stripe"
      And the search does not offer "Airtable"

    Scenario: Leaving the catalog returns to the fleet
      When they open the address of the fleet "Staging" followed by "/add-emulator"
      And they follow "Staging"
      Then they see the page "Staging"
      And they see "This fleet has no emulators"

  Rule: An emulator is named and given a durability on a form of its own

    Background:
      Given Ada has a fleet "Staging" in the project "Web app"

    Scenario: Adding an emulator puts it in the fleet, at its own address, noted as just added
      When they open the address of the fleet "Staging" followed by "/add-emulator"
      And they type "stripe" into "Search emulators"
      And they follow the offer "Stripe"
      Then they see the page "Add Stripe to Staging"
      And the screen is the "emulator.add.configure" form
      And the field "Instance name" holds "stripe"
      And "Buffered" is chosen for "Durability"
      When they press "Add emulator"
      Then they see the page "Staging"
      And the emulator "stripe" is noted "Added just now"
      And "Buffered" is the durability of "stripe"
      And the address of the "stripe" emulator of "Staging" is on its card with a "Copy URL" button
      And a caller without a key can use the "stripe" emulator of "Staging"

    Scenario: The durability can be chosen when adding
      When they open the address of the fleet "Staging" followed by "/add-emulator/resend"
      And they choose "Strict" as the "Durability"
      And they press "Add emulator"
      Then "Strict" is the durability of "resend"
      And the API reports the durability of the "resend" emulator of "Staging" as "strict"

    Scenario: A second instance of the same emulator is offered a numbered name
      Given Ada has a fleet "Preview" in the project "Web app" with a "stripe" emulator named "stripe"
      When they open the address of the fleet "Preview" followed by "/add-emulator"
      And they type "stripe" into "Search emulators"
      Then the offer "Stripe" says "in this fleet"
      When they follow the offer "Stripe"
      Then the field "Instance name" holds "stripe-2"
      And they see "This fleet already runs stripe, so this one is numbered."
      When they press "Add emulator"
      Then there is an emulator "stripe"
      And there is an emulator "stripe-2"
      And the "stripe-2" emulator is labelled as "Stripe"

    Scenario: A name the fleet already uses is pointed out under the field
      Given Ada has a fleet "Preview" in the project "Web app" with a "stripe" emulator named "stripe"
      When they open the address of the fleet "Preview" followed by "/add-emulator/stripe"
      And they type "stripe" into "Instance name"
      And they press "Add emulator"
      Then the field "Instance name" says "This fleet already has an emulator named stripe. Choose another name."
      And exactly 1 problem is pointed out

    Scenario: A name that cannot be part of an address is pointed out under the field
      When they open the address of the fleet "Staging" followed by "/add-emulator/stripe"
      And they type "My Stripe!" into "Instance name"
      And they press "Add emulator"
      Then the field "Instance name" says "Use lowercase letters, digits and hyphens"

    Scenario: An empty name is pointed out under the field
      When they open the address of the fleet "Staging" followed by "/add-emulator/stripe"
      And they clear "Instance name"
      And they press "Add emulator"
      Then the field "Instance name" says "Enter a name for this emulator."

    Scenario: Cancel returns to the catalog and adds nothing
      When they open the address of the fleet "Staging" followed by "/add-emulator"
      And they follow the offer "Stripe"
      And they cancel
      Then they see the page "Add an emulator to Staging"
      When they follow "Staging"
      Then they see "This fleet has no emulators"

    Scenario: An emulator the catalog does not have is not found
      When they open the address of the fleet "Staging" followed by "/add-emulator/mainframe"
      Then they are told it was not found
      And they see "The catalog has no emulator called mainframe."

  Rule: An emulator's durability is changed on a screen of its own

    Background:
      Given Ada has a fleet "Staging" in the project "Web app" running:
        | name   | emulator | durability |
        | resend | resend   | buffered   |

    Scenario: Each choice says what it costs, and the current one is marked
      When they open the fleet "Staging"
      And they follow "Change the durability of resend"
      Then they see the page "Change the durability of resend"
      And the screen is the "emulator.durability" form
      And the durability choices are:
        | Strict    | Committed to storage before every response. Slowest; nothing acknowledged is ever lost. |
        | Buffered  | Served from memory, saved moments later. Fast; a crash loses the last seconds.          |
        | Ephemeral | Memory only. Fastest; state is gone when the service restarts.                          |
      And "Buffered" is chosen for "Durability"

    Scenario Outline: Switching to <durability> takes effect, is noted on the card, and lasts
      When they open the fleet "Staging"
      And they follow "Change the durability of resend"
      And they choose "<durability>" as the "Durability"
      And they press "Save durability"
      Then they see the page "Staging"
      And "<durability>" is the durability of "resend"
      And the durability of "resend" is noted "Changed just now"
      And the API reports the durability of the "resend" emulator of "Staging" as "<mode>"
      When they reload the page
      Then "<durability>" is the durability of "resend"
      And no note is shown

      Examples:
        | durability | mode      |
        | Strict     | strict    |
        | Ephemeral  | ephemeral |

    Scenario: Saving the durability it already has is pointed out
      When they open the fleet "Staging"
      And they follow "Change the durability of resend"
      And they press "Save durability"
      Then the field "Durability" says "resend is already buffered. Choose a different mode, or cancel."
      And exactly 1 problem is pointed out

    Scenario: Cancel keeps the durability
      When they open the fleet "Staging"
      And they follow "Change the durability of resend"
      And they choose "Strict" as the "Durability"
      And they cancel
      Then "Buffered" is the durability of "resend"
      And the API reports the durability of the "resend" emulator of "Staging" as "buffered"

    Scenario: Only a buffered emulator offers to be saved now
      When they open the fleet "Staging"
      Then there is a link "Save resend now"
      When they follow "Change the durability of resend"
      And they choose "Strict" as the "Durability"
      And they press "Save durability"
      Then there is no link "Save resend now"

  Rule: Each card says where its emulator's state stands

    Scenario: An emulator nobody has called has nothing to save
      Given Ada has a fleet "Staging" in the project "Web app" running:
        | name   | emulator | durability |
        | resend | resend   | buffered   |
      When they open the fleet "Staging"
      Then the state of "resend" reads "idle"

    Scenario: A buffered emulator has unsaved changes until it is saved
      Given Ada has a fleet "Staging" in the project "Web app" running:
        | name   | emulator | durability |
        | resend | resend   | buffered   |
      And 1 email has been sent through the "resend" emulator of "Staging"
      When they open the fleet "Staging"
      Then the state of "resend" reads "unsaved changes"
      When they follow "Save resend now"
      Then they see the page "Save resend now"
      And the screen is the "emulator.save" form
      When they press "Save now"
      Then they see the page "Staging"
      And the emulator "resend" is noted "Saved just now"
      And the state of "resend" reads "saved"

    Scenario: Cancelling the save leaves the changes unsaved
      Given Ada has a fleet "Staging" in the project "Web app" running:
        | name   | emulator | durability |
        | resend | resend   | buffered   |
      And 1 email has been sent through the "resend" emulator of "Staging"
      When they open the fleet "Staging"
      And they follow "Save resend now"
      And they cancel
      Then the state of "resend" reads "unsaved changes"

    Scenario: A strict emulator is saved by the time it answers
      Given Ada has a fleet "Staging" in the project "Web app" running:
        | name   | emulator | durability |
        | resend | resend   | strict     |
      And 1 email has been sent through the "resend" emulator of "Staging"
      When they open the fleet "Staging"
      Then the state of "resend" reads "saved"

    Scenario: An ephemeral emulator is never stored
      Given Ada has a fleet "Staging" in the project "Web app" running:
        | name   | emulator | durability |
        | resend | resend   | ephemeral  |
      And 1 email has been sent through the "resend" emulator of "Staging"
      When they open the fleet "Staging"
      Then the state of "resend" reads "not stored"

  Rule: An emulator's state can be downloaded, reset, or removed with the emulator

    Background:
      Given Ada has a fleet "Staging" in the project "Web app" running:
        | name   | emulator | durability |
        | resend | resend   | strict     |
        | stripe | stripe   | strict     |
      And 1 email has been sent through the "resend" emulator of "Staging"

    Scenario: Downloading the state saves it as a file named after the fleet and emulator
      When they open the fleet "Staging"
      And they download the state of "resend"
      Then a file named after the fleet "Staging" and the emulator "resend" is saved
      And the saved file holds the email that was sent
      And they see the page "Staging"

    Scenario: Resetting an emulator erases its state and keeps it in the fleet
      When they open the fleet "Staging"
      And they follow "Reset the state of resend"
      Then they see the page "Reset resend"
      And the screen is the "emulator.reset" form
      And they see "The emulator stays in the fleet at the same URL and starts again empty."
      When they press "Reset state"
      Then they see the page "Staging"
      And the emulator "resend" is noted "Reset just now"
      And the email that was sent is gone from the "resend" emulator of "Staging"

    Scenario: Cancelling the reset keeps the state
      When they open the fleet "Staging"
      And they follow "Reset the state of resend"
      And they cancel
      Then they see the page "Staging"
      And the email that was sent is still in the "resend" emulator of "Staging"

    Scenario: Removing an emulator takes it and its address away
      When they open the fleet "Staging"
      And they follow "Remove resend"
      Then they see the page "Remove resend from Staging"
      And the screen is the "emulator.remove" form
      When they press "Remove emulator"
      Then they see the page "Staging"
      And they see the note "resend was removed just now."
      And there is no emulator "resend"
      And there is an emulator "stripe"
      And the "resend" emulator of "Staging" no longer answers

    Scenario: Cancelling the removal keeps the emulator
      When they open the fleet "Staging"
      And they follow "Remove resend"
      And they cancel
      Then there is an emulator "resend"
      And the email that was sent is still in the "resend" emulator of "Staging"

    Scenario: An emulator removed elsewhere in the meantime is reported in the form
      When they open the fleet "Staging"
      And they follow "Remove resend"
      And the emulator "resend" is removed from "Staging" through the API
      And they press "Remove emulator"
      Then the form says "The emulator was not removed."
      And no field is marked wrong

    Scenario: The address of an emulator the fleet does not have is not found
      When they open the address of the fleet "Staging" followed by "/emulators/mailgun/reset"
      Then they are told it was not found
      And they see "Staging has no emulator named mailgun."
