@fleets @serving
Feature: Calling the emulators of a fleet
  A fleet gives each of its emulators a stable URL. A vendor SDK is pointed at that URL and
  needs nothing else on an open fleet: no Mockingbird credential and no special headers. A
  key-protected fleet asks every caller for a Mockingbird API key, and an emulator's admin
  routes ask for one that may change things, whatever the fleet's access.

  Scenario: An SDK needs only the emulator's URL on an open fleet
    Given Ada has an open fleet "Staging" with a buffered Resend emulator
    When an SDK sends an email through "Staging"
    Then the email is accepted
    And the email can be read back

  Scenario: The fleet's URL lists its emulators and where to point each SDK
    Given Ada has an open fleet "Staging" with these emulators:
      | name    | target | durability |
      | mail    | resend | strict     |
      | billing | stripe | ephemeral  |
    When anyone opens the URL of "Staging"
    Then the discovery document lists these emulators:
      | name    | target | durability |
      | mail    | resend | strict     |
      | billing | stripe | ephemeral  |
    And each listed URL is the fleet's URL followed by the emulator's name

  Scenario: A listed emulator URL is all a different vendor's SDK needs too
    Given Ada has an open fleet "Staging" with these emulators:
      | name    | target | durability |
      | billing | stripe | buffered   |
    When a Stripe SDK creates a customer through the "billing" emulator of "Staging"
    Then the request succeeds

  Scenario: A fleet nobody has created is not found
    When an SDK calls a fleet nobody has created
    Then the response status is 404
    And the request is refused as "not_found"
    And the message says "Fleet not found"

  Scenario: An emulator the fleet does not have is not found
    Given Ada has an open fleet "Staging" with a buffered Resend emulator
    When an SDK calls the "twilio" emulator of "Staging"
    Then the response status is 404
    And the request is refused as "not_found"
    And the message says "Emulator not found"

  Scenario: An emulator added to a fleet is reachable at once
    Given Ada has an open fleet "Staging" with a buffered Resend emulator
    And an SDK has already called the "receipts" emulator of "Staging" in vain
    When Ada adds a Resend emulator "receipts" to "Staging"
    And an SDK sends an email through the "receipts" emulator of "Staging"
    Then the email is accepted

  Scenario: The vendor's Authorization header is the emulator's business, not Mockingbird's
    Given Ada has an open fleet "Staging" with a buffered Resend emulator
    When an SDK sends an email through "Staging" without the vendor's API key
    Then the emulator answers with the vendor's own "missing_api_key" error

  Scenario: The vendor's Authorization header reaches the emulator untouched
    Given Ada has an open fleet "Staging" with a buffered Resend emulator
    And the emulator of "Staging" files the vendor key "re_blue_team" under the namespace "blue"
    When an SDK sends an email through "Staging" with the vendor key "re_blue_team"
    Then the email can be read back in the namespace "blue"
    But the email cannot be read back without a namespace

  Rule: A key-protected fleet needs a Mockingbird API key on every call

    Background:
      Given Ada has a key-protected fleet "Staging" with a buffered Resend emulator

    Scenario Outline: A key-protected fleet serves a caller presenting <credential>
      When an SDK sends an email through "Staging" presenting <credential>
      Then the email is accepted

      Examples:
        | credential                    |
        | a viewer key                  |
        | a member key                  |
        | an admin key                  |
        | a key for the fleet's project |

    Scenario Outline: A key-protected fleet refuses a caller presenting <credential>
      When an SDK sends an email through "Staging" presenting <credential>
      Then the response status is <status>
      And the request is refused as "<reason>"

      Examples:
        | credential                                        | status | reason       |
        | no key                                            | 401    | unauthorized |
        | a malformed key                                   | 401    | unauthorized |
        | an unknown key                                    | 401    | unauthorized |
        | only a dashboard session                          | 401    | unauthorized |
        | a member key in the vendor's Authorization header | 401    | unauthorized |
        | a key from another organization                   | 403    | forbidden    |
        | a key for another project                         | 403    | forbidden    |

    Scenario: The discovery document of a key-protected fleet needs a key as well
      When anyone opens the URL of "Staging"
      Then the response status is 401
      And the message says "x-mockingbird-api-key"

  Rule: A key that has no access to a fleet is refused even when the fleet is open

    Scenario: A key from another organization is refused on an open fleet
      Given Ada has an open fleet "Staging" with a buffered Resend emulator
      When an SDK sends an email through "Staging" presenting a key from another organization
      Then the response status is 403
      And the request is refused as "forbidden"

  Rule: An emulator's admin routes always need a key that may change things

    Background:
      Given Ada has an open fleet "Staging" with a buffered Resend emulator

    Scenario Outline: The admin routes of an open fleet's emulator refuse a caller presenting <credential>
      When the admin routes of the "Staging" emulator are called presenting <credential>
      Then the response status is <status>
      And the request is refused as "<reason>"

      Examples:
        | credential                      | status | reason       |
        | no key                          | 401    | unauthorized |
        | only a dashboard session        | 401    | unauthorized |
        | a viewer key                    | 403    | forbidden    |
        | a key from another organization | 403    | forbidden    |

    Scenario Outline: The admin routes answer a caller presenting <credential>
      When the admin routes of the "Staging" emulator are called presenting <credential>
      Then the emulator's admin routes answer

      Examples:
        | credential                    |
        | a member key                  |
        | an admin key                  |
        | a key for the fleet's project |

  Rule: State is kept apart by namespace, by emulator and by fleet

    Scenario: Namespaces keep parallel test runs apart on one emulator
      Given Ada has an open fleet "Staging" with a buffered Resend emulator
      When an SDK sends an email through "Staging" in the namespace "run-1"
      Then the email can be read back in the namespace "run-1"
      But the email cannot be read back in the namespace "run-2"
      And the email cannot be read back without a namespace

    Scenario: Two instances of the same emulator in one fleet are independent
      Given Ada has an open fleet "Staging" with these emulators:
        | name      | target | durability |
        | marketing | resend | buffered   |
        | receipts  | resend | buffered   |
      When an SDK sends an email through the "marketing" emulator of "Staging"
      Then the email can be read back from the "marketing" emulator of "Staging"
      But the email cannot be read back from the "receipts" emulator of "Staging"

    Scenario: Two fleets are isolated from each other
      Given Ada has an open fleet "Staging" with a buffered Resend emulator
      And Grace has an open fleet "Preview" with a buffered Resend emulator
      When an SDK sends an email through "Staging"
      Then the email can be read back
      But the email cannot be read back from the fleet "Preview"
