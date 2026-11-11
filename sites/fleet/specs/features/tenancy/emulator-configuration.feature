@tenancy
Feature: Configuring a fleet's emulators
  Each emulator in a fleet has a name, the vendor API it emulates, and settings such as how
  durable its state is. Emulators are added, replaced, changed and removed one at a time.

  Background:
    Given Ada owns an organization "Acme"
    And Ada has a project "Web" in "Acme"
    And Ada has a fleet "Staging" in the project "Web"

  Rule: Emulators are added, replaced, changed and removed by name

    Scenario: Adding an emulator
      When Ada adds a "stripe" emulator named "payments" to the fleet "Staging"
      Then the request succeeds
      And the fleet "Staging" has the emulators:
        | name     | emulates | durability |
        | payments | stripe   | buffered   |
      And each emulator of the fleet "Staging" is addressed beneath the fleet, by its name

    Scenario: A fleet may run the same vendor more than once, under different names
      Given Ada adds a "resend" emulator named "mail" to the fleet "Staging"
      When Ada adds a "resend" emulator named "outbox" to the fleet "Staging"
      Then the fleet "Staging" has the emulators:
        | name   | emulates | durability |
        | mail   | resend   | buffered   |
        | outbox | resend   | buffered   |

    Scenario: Replacing an emulator's configuration forgets whatever is not restated
      Given Ada adds a "resend" emulator named "mail" to the fleet "Staging" with:
        | durability | strict   |
        | seed       | abc      |
      When Ada adds a "resend" emulator named "mail" to the fleet "Staging"
      Then the emulator "mail" of the fleet "Staging" is configured with:
        | durability | buffered |
        | seed       |          |

    Scenario: Changing one thing keeps the rest
      Given Ada adds a "resend" emulator named "mail" to the fleet "Staging" with:
        | durability | strict   |
        | seed       | abc      |
      When Ada changes the emulator "mail" of the fleet "Staging" with:
        | durability | ephemeral |
      Then the request succeeds
      And the emulator "mail" of the fleet "Staging" is configured with:
        | durability | ephemeral |
        | seed       | abc       |

    Scenario: Changing an emulator leaves the fleet's other emulators alone
      Given Ada adds a "resend" emulator named "mail" to the fleet "Staging"
      And Ada adds a "stripe" emulator named "payments" to the fleet "Staging"
      When Ada changes the emulator "mail" of the fleet "Staging" with:
        | durability | strict |
      Then the fleet "Staging" has the emulators:
        | name     | emulates | durability |
        | mail     | resend   | strict     |
        | payments | stripe   | buffered   |

    Scenario: An emulator that is not there cannot be changed
      When Ada changes the emulator "mail" of the fleet "Staging" with:
        | durability | strict |
      Then the request is refused as "not_found"
      And the fleet "Staging" has no emulators

    Scenario: Removing an emulator
      Given Ada adds a "resend" emulator named "mail" to the fleet "Staging"
      And Ada adds a "stripe" emulator named "payments" to the fleet "Staging"
      When Ada removes the emulator "mail" from the fleet "Staging"
      Then the request succeeds
      And the fleet "Staging" has the emulators:
        | name     | emulates | durability |
        | payments | stripe   | buffered   |

    Scenario: An emulator that is not there cannot be removed
      When Ada removes the emulator "mail" from the fleet "Staging"
      Then the request is refused as "not_found"

    Scenario Outline: An emulator cannot be named "<name>"
      When Ada adds a "resend" emulator named "<name>" to the fleet "Staging"
      Then the request is refused as "invalid_request"
      And the message says "Emulator names are lowercase letters, digits and hyphens"
      And the fleet "Staging" has no emulators

      Examples:
        | name      |
        | Mail      |
        | my_mail   |
        | mail.v2   |
        | -mail     |

  Rule: Durability is chosen per emulator

    Scenario Outline: An emulator can be <durability>
      When Ada adds a "resend" emulator named "mail" to the fleet "Staging" with:
        | durability | <durability> |
      Then the request succeeds
      And the emulator "mail" of the fleet "Staging" is configured with:
        | durability | <durability> |

      Examples:
        | durability |
        | strict     |
        | buffered   |
        | ephemeral  |

    Scenario: An unknown durability is refused
      Given Ada adds a "resend" emulator named "mail" to the fleet "Staging"
      When Ada changes the emulator "mail" of the fleet "Staging" with:
        | durability | eventually |
      Then the request is refused as "invalid_request"
      And the emulator "mail" of the fleet "Staging" is configured with:
        | durability | buffered |

    Scenario Outline: A flush interval of <milliseconds> ms is <outcome>
      When Ada adds a "resend" emulator named "mail" to the fleet "Staging" with:
        | flushIntervalMs | <milliseconds> |
      Then the response status is <status>

      Examples:
        | milliseconds | outcome  | status |
        | 99           | refused  | 400    |
        | 100          | accepted | 200    |
        | 60000        | accepted | 200    |
        | 60001        | refused  | 400    |

  Rule: Only HTTP emulators from the catalog can be hosted

    Scenario: An emulator the catalog does not have is refused
      When Ada adds a "no-such-vendor" emulator named "thing" to the fleet "Staging"
      Then the request is refused as "unknown_emulator"
      And the response status is 400
      And the fleet "Staging" has no emulators

    Scenario Outline: The wire-protocol emulator "<target>" cannot be hosted
      When Ada adds a "<target>" emulator named "db" to the fleet "Staging"
      Then the response status is 400
      And the fleet "Staging" has no emulators

      Examples:
        | target   |
        | postgres |
        | redis    |
        | sqlite   |

    Scenario: An emulator cannot be switched to something the catalog does not have
      Given Ada adds a "resend" emulator named "mail" to the fleet "Staging"
      When Ada changes the emulator "mail" of the fleet "Staging" with:
        | target | no-such-vendor |
      Then the request is refused as "unknown_emulator"
      And the fleet "Staging" has the emulators:
        | name | emulates | durability |
        | mail | resend   | buffered   |

    Scenario: An emulator can be switched to another vendor
      Given Ada adds a "resend" emulator named "thing" to the fleet "Staging"
      When Ada changes the emulator "thing" of the fleet "Staging" with:
        | target | stripe |
      Then the request succeeds
      And the fleet "Staging" has the emulators:
        | name  | emulates | durability |
        | thing | stripe   | buffered   |

  Rule: An emulator's own settings are checked by that emulator

    Scenario: Settings the emulator understands are kept
      When Ada adds a "formbricks" emulator named "surveys" to the fleet "Staging" with the settings:
        | contactsEnabled | true |
      Then the request succeeds
      And the emulator "surveys" of the fleet "Staging" has the settings:
        | contactsEnabled | true |

    Scenario: A setting with the wrong kind of value is refused
      When Ada adds a "formbricks" emulator named "surveys" to the fleet "Staging" with the settings:
        | contactsEnabled | "yes" |
      Then the request is refused as "invalid_settings"
      And the response status is 400
      And the message says "contactsEnabled must be a boolean"
      And the fleet "Staging" has no emulators

    Scenario: A setting the emulator does not have is refused
      When Ada adds a "formbricks" emulator named "surveys" to the fleet "Staging" with the settings:
        | colour | "blue" |
      Then the request is refused as "invalid_settings"
      And the fleet "Staging" has no emulators

    Scenario: An emulator that takes no settings refuses any
      When Ada adds a "resend" emulator named "mail" to the fleet "Staging" with the settings:
        | anything | 1 |
      Then the request is refused as "invalid_settings"
      And the message says "takes no settings"

    Scenario: Settings survive a change to something else
      Given Ada adds a "formbricks" emulator named "surveys" to the fleet "Staging" with the settings:
        | contactsEnabled | true |
      When Ada changes the emulator "surveys" of the fleet "Staging" with:
        | durability | strict |
      Then the emulator "surveys" of the fleet "Staging" has the settings:
        | contactsEnabled | true |

    Scenario: Settings do not follow an emulator to another vendor
      Given Ada adds a "formbricks" emulator named "surveys" to the fleet "Staging" with the settings:
        | contactsEnabled | true |
      When Ada changes the emulator "surveys" of the fleet "Staging" with:
        | target | resend |
      Then the request succeeds
      And the emulator "surveys" of the fleet "Staging" has no settings

  Rule: An emulator delivers webhooks only to public https origins it was given

    Scenario: Webhook delivery is off unless origins are listed
      When Ada adds a "resend" emulator named "mail" to the fleet "Staging"
      Then the emulator "mail" of the fleet "Staging" may deliver webhooks to no origins

    Scenario: A public https origin is accepted
      When Ada lets the emulator "mail" of the fleet "Staging" deliver webhooks to "https://app.example.com"
      Then the request succeeds
      And the emulator "mail" of the fleet "Staging" may deliver webhooks to "https://app.example.com"

    Scenario Outline: The webhook origin "<origin>" is refused: <why>
      When Ada lets the emulator "mail" of the fleet "Staging" deliver webhooks to "<origin>"
      Then the request is refused as "invalid_request"
      And the message says "must be a public https origin"
      And the fleet "Staging" has no emulators

      Examples:
        | origin                        | why                    |
        | http://app.example.com        | not https              |
        | https://localhost             | loopback               |
        | https://127.0.0.1             | a loopback address     |
        | https://10.0.0.5              | a private address      |
        | https://[::1]                 | an IPv6 address        |
        | https://db.internal           | an internal name       |
        | https://printer.local         | a local name           |
        | https://intranet              | not a public name      |
        | https://app.example.com/path  | a URL, not an origin   |
        | https://app.example.com/      | a URL, not an origin   |
        | app.example.com               | not a URL              |

    Scenario: Clearing the origins turns delivery off again
      Given Ada lets the emulator "mail" of the fleet "Staging" deliver webhooks to "https://app.example.com"
      When Ada stops the emulator "mail" of the fleet "Staging" delivering webhooks
      Then the request succeeds
      And the emulator "mail" of the fleet "Staging" may deliver webhooks to no origins

  Rule: Simultaneous edits to different emulators of one fleet all survive

    Scenario: Two people add different emulators at the same moment
      Given Grace has joined "Acme" with the member role
      When Ada adds a "stripe" emulator named "payments" while Grace adds a "resend" emulator named "mail" to the fleet "Staging"
      Then the fleet "Staging" has the emulators:
        | name     | emulates | durability |
        | payments | stripe   | buffered   |
        | mail     | resend   | buffered   |

    Scenario: Simultaneous changes to two emulators both take effect
      Given Ada adds a "resend" emulator named "mail" to the fleet "Staging"
      And Ada adds a "resend" emulator named "outbox" to the fleet "Staging"
      When Ada makes the emulators "mail" and "outbox" of the fleet "Staging" strict at the same moment
      Then the fleet "Staging" has the emulators:
        | name   | emulates | durability |
        | mail   | resend   | strict     |
        | outbox | resend   | strict     |

    Scenario: A burst of additions loses nothing
      When Ada adds 4 "resend" emulators to the fleet "Staging" at the same moment
      Then the fleet "Staging" has 4 emulators
