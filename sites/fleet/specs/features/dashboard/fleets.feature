@dashboard
Feature: A fleet in the dashboard
  A fleet is a set of emulators behind one stable URL. Its page shows the addresses to point
  vendor SDKs at and its settings: its name, who may call it, and how many requests a minute it
  accepts. Each setting is changed on a screen of its own, reached by the link beside it, and the
  page notes the setting that was just changed. Deleting the fleet is a screen of its own too.

  Background:
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"
    And Ada has a project "Web app" in "Acme"

  Rule: A fleet's page shows its addresses and settings

    Scenario: An empty fleet says what to do next
      Given Ada has a fleet "Staging" in the project "Web app"
      When they open the fleet "Staging"
      Then they see the page "Staging"
      And they see "Point each vendor SDK's base URL at its emulator below."
      And they see "This fleet has no emulators"
      And they see "Add one to get its URL."
      And there is a link "Add an emulator"

    Scenario: A new fleet is open to anyone and runs at the organization's ceiling
      Given Ada has a fleet "Staging" in the project "Web app"
      When they open the fleet "Staging"
      Then the setting "Name" reads "Staging"
      And the setting "Who can call it" reads "Anyone with the URL"
      And the setting "Requests per minute" reads "The organization's ceiling"

    Scenario: The fleet's address and each emulator's address are on screen, ready to copy
      Given Ada has a fleet "Staging" in the project "Web app" running:
        | name   | emulator | durability |
        | stripe | stripe   | strict     |
        | resend | resend   | buffered   |
      When they open the fleet "Staging"
      Then the address of the fleet "Staging" is on screen with a "Copy URL" button
      And the address of the "stripe" emulator of "Staging" is on its card with a "Copy URL" button
      And the address of the "resend" emulator of "Staging" is on its card with a "Copy URL" button

    Scenario: Copying an address puts it on the clipboard and says so on the button
      Given Ada has a fleet "Staging" in the project "Web app"
      When they open the fleet "Staging"
      And they press "Copy URL" beside the address of the fleet "Staging"
      Then there is a button "Copied"
      And the clipboard holds the address of the fleet "Staging"
      And nothing on the page announces itself outside the screen

    Scenario: A fleet leads back to its project and organization
      Given Ada has a fleet "Staging" in the project "Web app"
      When they open the fleet "Staging"
      And they follow "Web app"
      Then they see the page "Web app"
      When they go back
      And they follow "Acme"
      Then they see the page "Acme"

  Rule: A fleet is renamed on a screen of its own

    Background:
      Given Ada has a fleet "Staging" in the project "Web app"

    Scenario: Renaming a fleet notes the new name beside it and keeps its address
      When they open the fleet "Staging"
      And they follow "Rename the fleet"
      Then they see the page "Rename Staging"
      And the screen is the "fleet.rename" form
      And the field "Name" holds "Staging"
      When they type "Preview" into "Name"
      And they press "Rename fleet"
      Then they see the page "Preview"
      And the setting "Name" reads "Preview"
      And the setting "Name" is noted "Renamed just now"
      And the address is that of the fleet "Staging"
      And the address of the fleet "Staging" is on screen with a "Copy URL" button

    Scenario: An empty name is pointed out under the field
      When they open the fleet "Staging"
      And they follow "Rename the fleet"
      And they clear "Name"
      And they press "Rename fleet"
      Then the field "Name" says "Enter a name for the fleet."
      And they see the page "Rename Staging"

    Scenario: Cancel keeps the name
      When they open the fleet "Staging"
      And they follow "Rename the fleet"
      And they type "Preview" into "Name"
      And they cancel
      Then they see the page "Staging"
      And no note is shown

  Rule: A fleet is open to anyone with its URL, or only to callers with an API key

    Background:
      Given Ada has a fleet "Staging" in the project "Web app" running:
        | name   | emulator | durability |
        | resend | resend   | strict     |

    Scenario: A new fleet can be called without a key
      Then a caller without a key can use the "resend" emulator of "Staging"

    Scenario: Requiring a key shuts out callers without one
      When they open the fleet "Staging"
      And they follow "Change who can call the fleet"
      Then they see the page "Change who can call Staging"
      And the screen is the "fleet.access" form
      And "Anyone with the URL" is chosen for "Who can call this fleet"
      When they choose "Only requests with an API key" as the "Who can call this fleet"
      And they press "Save access"
      Then they see the page "Staging"
      And the setting "Who can call it" reads "Only requests with an API key"
      And the setting "Who can call it" is noted "Changed just now"
      And a caller without a key is refused by the "resend" emulator of "Staging"

    Scenario: Opening a protected fleet again lets everyone in
      Given the fleet "Staging" requires an API key
      When they open the fleet "Staging"
      And they follow "Change who can call the fleet"
      And they choose "Anyone with the URL" as the "Who can call this fleet"
      And they press "Save access"
      Then the setting "Who can call it" reads "Anyone with the URL"
      And a caller without a key can use the "resend" emulator of "Staging"

    Scenario: Saving the access it already has is pointed out
      When they open the fleet "Staging"
      And they follow "Change who can call the fleet"
      And they press "Save access"
      Then the field "Who can call this fleet" says "This is who can call the fleet now. Choose the other option, or cancel."
      And exactly 1 problem is pointed out

    Scenario: Cancel keeps the fleet open
      When they open the fleet "Staging"
      And they follow "Change who can call the fleet"
      And they choose "Only requests with an API key" as the "Who can call this fleet"
      And they cancel
      Then the setting "Who can call it" reads "Anyone with the URL"
      And a caller without a key can use the "resend" emulator of "Staging"

  Rule: A fleet can accept fewer requests per minute than the organization's ceiling

    Background:
      Given Ada has a fleet "Staging" in the project "Web app" running:
        | name   | emulator | durability |
        | resend | resend   | ephemeral  |

    Scenario: Setting a rate limit takes effect and is noted beside it
      When they open the fleet "Staging"
      And they follow "Change the requests per minute"
      Then they see the page "Change the requests per minute of Staging"
      And the screen is the "fleet.rate-limit" form
      And they see "A whole number from 1 to 3,000, the organization's ceiling."
      When they type "2" into "Requests per minute"
      And they press "Save rate limit"
      Then they see the page "Staging"
      And the setting "Requests per minute" reads "2"
      And the setting "Requests per minute" is noted "Changed just now"
      And after 2 requests in a row the "resend" emulator of "Staging" refuses the next as too many

    Scenario: A rate above the organization's ceiling is pointed out before asking the server
      When they open the fleet "Staging"
      And they follow "Change the requests per minute"
      And they type "999999" into "Requests per minute"
      And they press "Save rate limit"
      Then the field "Requests per minute" says "Enter 3,000 or less: that is the organization's ceiling."
      And exactly 1 problem is pointed out

    Scenario Outline: A rate of "<rate>" is pointed out under the field
      When they open the fleet "Staging"
      And they follow "Change the requests per minute"
      And they type "<rate>" into "Requests per minute"
      And they press "Save rate limit"
      Then the field "Requests per minute" says "<problem>"

      Examples:
        | rate | problem                                              |
        | 0    | Enter a whole number, 1 or more.                     |
        | 2.5  | Enter a whole number, 1 or more.                     |
        |      | Enter how many requests a minute the fleet accepts.  |

    Scenario: Cancel keeps the organization's ceiling
      When they open the fleet "Staging"
      And they follow "Change the requests per minute"
      And they type "2" into "Requests per minute"
      And they cancel
      Then the setting "Requests per minute" reads "The organization's ceiling"
      And the API reports no requests per minute of its own for "Staging"

  Rule: A fleet is deleted on a screen of its own

    Background:
      Given Ada has a fleet "Staging" in the project "Web app" running:
        | name   | emulator | durability |
        | resend | resend   | strict     |

    Scenario: Deleting a fleet says what goes with it, then returns to its project
      When they open the fleet "Staging"
      And they follow "Delete fleet…"
      Then they see the page "Delete Staging"
      And the screen is the "fleet.delete" form
      And they see "the stored state of its 1 emulator (resend) is erased."
      When they press "Delete fleet"
      Then they see the page "Web app"
      And they see the note "Staging was deleted just now."
      And they see "No fleets yet"
      And the address of the fleet "Staging" no longer answers

    Scenario: Cancelling keeps the fleet
      When they open the fleet "Staging"
      And they follow "Delete fleet…"
      And they cancel
      Then they see the page "Staging"
      And a caller without a key can use the "resend" emulator of "Staging"

    Scenario: A fleet of a suspended organization cannot be changed, and the form says why
      Given the operator has suspended "Acme" for "unpaid invoice"
      When they open the fleet "Staging"
      And they follow "Rename the fleet"
      And they type "Preview" into "Name"
      And they press "Rename fleet"
      Then the form says "The fleet was not renamed."
      And the form says "This organization is suspended: unpaid invoice."
      And no field is marked wrong
