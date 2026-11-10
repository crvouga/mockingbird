@dashboard
Feature: The emulators of a fleet in the dashboard
  A fleet's page is where emulators are added from the catalog, where each one's durability is
  chosen, and where its stored state is saved, downloaded, reset or removed.

  Background:
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"
    And Ada has a project "Web app" in "Acme"

  Rule: Emulators are added by searching the catalog

    Background:
      Given Ada has a fleet "Staging" in the project "Web app"

    Scenario: Putting the cursor in the search lists the catalog
      When they open the fleet "Staging"
      And they put the cursor in "Search emulators"
      Then the search offers "Airtable"
      And the search offers 40 emulators to choose from

    Scenario: Searching narrows the catalog
      When they open the fleet "Staging"
      And they type "stripe" into "Search emulators"
      Then the search offers "Stripe"
      And the search does not offer "Airtable"

    Scenario: A search can match a category
      When they open the fleet "Staging"
      And they type "payments" into "Search emulators"
      Then the search offers "Stripe"

    Scenario: A search that matches nothing says so
      When they open the fleet "Staging"
      And they type "mainframe" into "Search emulators"
      Then they see "No emulator matches that search."

    Scenario: Choosing an emulator adds it to the fleet, buffered, at its own address
      When they open the fleet "Staging"
      And they type "stripe" into "Search emulators"
      And they add "Stripe" from the catalog
      Then there is an emulator "stripe"
      And "Buffered" is the durability of "stripe"
      And the address of the "stripe" emulator of "Staging" is on its card with a "Copy URL" button
      And a caller without a key can use the "stripe" emulator of "Staging"

    Scenario: A second instance of the same emulator gets a numbered name
      When they open the fleet "Staging"
      And they type "stripe" into "Search emulators"
      And they add "Stripe" from the catalog
      And they type "stripe" into "Search emulators"
      And they add "Stripe" from the catalog
      Then there is an emulator "stripe"
      And there is an emulator "stripe-2"
      And the "stripe-2" emulator is labelled as "Stripe"

  Rule: Each emulator's durability is chosen on its card

    Background:
      Given Ada has a fleet "Staging" in the project "Web app" running:
        | name   | emulator | durability |
        | resend | resend   | buffered   |

    Scenario: Each choice says what it costs
      When they open the fleet "Staging"
      Then the durability choices of "resend" are:
        | Strict    | Committed to storage before every response. Slowest; nothing acknowledged is ever lost. |
        | Buffered  | Served from memory, saved moments later. Fast; a crash loses the last seconds.          |
        | Ephemeral | Memory only. Fastest; state is gone when the service restarts.                          |

    Scenario Outline: Switching to <durability> takes effect and lasts
      When they open the fleet "Staging"
      And they switch the durability of "resend" to "<durability>"
      Then "<durability>" is the durability of "resend"
      When they reload the page
      Then "<durability>" is the durability of "resend"
      And the API reports the durability of the "resend" emulator of "Staging" as "<mode>"

      Examples:
        | durability | mode      |
        | Strict     | strict    |
        | Ephemeral  | ephemeral |

    Scenario: Only a buffered emulator can be saved on demand
      When they open the fleet "Staging"
      Then there is a button "Save now"
      When they switch the durability of "resend" to "Strict"
      Then there is no button "Save now"

  Rule: Each card says where its emulator's state stands

    Scenario: An emulator nobody has called has nothing to save
      Given Ada has a fleet "Staging" in the project "Web app" running:
        | name   | emulator | durability |
        | resend | resend   | buffered   |
      When they open the fleet "Staging"
      Then the state of "resend" reads "idle"

    Scenario: A buffered emulator has unsaved changes after a request, until it is saved
      Given Ada has a fleet "Staging" in the project "Web app" running:
        | name   | emulator | durability |
        | resend | resend   | buffered   |
      And they open the fleet "Staging"
      When 1 email has been sent through the "resend" emulator of "Staging"
      And they reload the page
      Then the state of "resend" reads "unsaved changes"
      When they press "Save now"
      Then the state of "resend" reads "saved"

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

  Rule: An emulator's state can be downloaded, reset or removed with the emulator

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

    Scenario: Resetting an emulator asks first, then erases its state
      When they open the fleet "Staging"
      And they press "Reset state" on "resend" and confirm
      Then they were asked "Reset resend? Its state is erased."
      And the email that was sent is gone from the "resend" emulator of "Staging"
      And there is an emulator "resend"

    Scenario: Declining the question keeps the state
      When they open the fleet "Staging"
      And they press "Reset state" on "resend" and decline
      Then the email that was sent is still in the "resend" emulator of "Staging"

    Scenario: Removing an emulator asks first, then takes it and its address away
      When they open the fleet "Staging"
      And they press "Remove" on "resend" and confirm
      Then they were asked "Remove resend from this fleet? Its state is erased."
      And there is no emulator "resend"
      And there is an emulator "stripe"
      And the "resend" emulator of "Staging" no longer answers
