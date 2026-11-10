@dashboard
Feature: A fleet in the dashboard
  A fleet is a set of emulators behind one stable URL. Its page shows the addresses to point
  vendor SDKs at, who may call it and how often, and is where it is deleted.

  Background:
    Given Ada is signed in to the dashboard
    And Ada owns an organization "Acme"
    And Ada has a project "Web app" in "Acme"

  Scenario: An empty fleet says what to do next
    Given Ada has a fleet "Staging" in the project "Web app"
    When they open the fleet "Staging"
    Then they see the page "Staging"
    And they see "Point each vendor SDK's base URL at its emulator below."
    And they see "This fleet is empty"
    And they see "Add an emulator below."

  Scenario: The fleet's address and each emulator's address are on screen, ready to copy
    Given Ada has a fleet "Staging" in the project "Web app" running:
      | name   | emulator | durability |
      | stripe | stripe   | strict     |
      | resend | resend   | buffered   |
    When they open the fleet "Staging"
    Then the address of the fleet "Staging" is on screen with a "Copy fleet URL" button
    And the address of the "stripe" emulator of "Staging" is on its card with a "Copy URL" button
    And the address of the "resend" emulator of "Staging" is on its card with a "Copy URL" button

  Scenario: Copying an address puts it on the clipboard
    Given Ada has a fleet "Staging" in the project "Web app"
    When they open the fleet "Staging"
    And they press "Copy fleet URL"
    Then there is a button "Copied"
    And the clipboard holds the address of the fleet "Staging"

  Scenario: A fleet leads back to its project and organization
    Given Ada has a fleet "Staging" in the project "Web app"
    When they open the fleet "Staging"
    And they follow "Web app"
    Then they see the page "Web app"
    When they go back
    And they follow "Organization"
    Then they see the page "Acme"

  Rule: A fleet is open to anyone with its URL, or only to callers with an API key

    Background:
      Given Ada has a fleet "Staging" in the project "Web app" running:
        | name   | emulator | durability |
        | resend | resend   | strict     |

    Scenario: A new fleet is open
      When they open the fleet "Staging"
      Then "Anyone with the URL" is chosen for "Who can call this fleet"
      And a caller without a key can use the "resend" emulator of "Staging"

    Scenario: Requiring a key shuts out callers without one, and lasts
      When they open the fleet "Staging"
      And they choose "Only requests with an API key (x-mockingbird-api-key)" as the "Who can call this fleet"
      Then a caller without a key is refused by the "resend" emulator of "Staging"
      When they reload the page
      Then "Only requests with an API key (x-mockingbird-api-key)" is chosen for "Who can call this fleet"

    Scenario: Opening a protected fleet again lets everyone in
      Given the fleet "Staging" requires an API key
      When they open the fleet "Staging"
      And they choose "Anyone with the URL" as the "Who can call this fleet"
      Then a caller without a key can use the "resend" emulator of "Staging"

  Rule: A fleet can accept fewer requests per minute than the organization's ceiling

    Background:
      Given Ada has a fleet "Staging" in the project "Web app" running:
        | name   | emulator | durability |
        | resend | resend   | ephemeral  |

    Scenario: A new fleet runs at the organization's ceiling
      When they open the fleet "Staging"
      Then the requests per minute field is empty

    Scenario: Setting a rate limit takes effect and lasts
      When they open the fleet "Staging"
      And they set the fleet's requests per minute to "2"
      And they reload the page
      Then the requests per minute field holds "2"
      And after 2 requests in a row the "resend" emulator of "Staging" refuses the next as too many

    Scenario: A rate above the organization's ceiling is refused
      When they open the fleet "Staging"
      And they set the fleet's requests per minute to "999999"
      Then they see the error "3000"
      When they reload the page
      Then the requests per minute field is empty

  Rule: Deleting a fleet asks first

    Background:
      Given Ada has a fleet "Staging" in the project "Web app" running:
        | name   | emulator | durability |
        | resend | resend   | strict     |

    Scenario: Deleting a fleet returns to its project and takes its URL away
      When they open the fleet "Staging"
      And they press "Delete fleet" and confirm
      Then they were asked "Delete Staging? Its URL stops working and all emulator state is erased."
      And they see the page "Web app"
      And they see "No fleets yet"
      And the address of the fleet "Staging" no longer answers

    Scenario: Declining the question keeps the fleet
      When they open the fleet "Staging"
      And they press "Delete fleet" and decline
      And they reload the page
      Then they see the page "Staging"
