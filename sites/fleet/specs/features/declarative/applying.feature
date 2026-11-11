@declarative
Feature: Applying a mockingbird.yaml to Fleet Cloud
  One file, kept in a repository, declares an organization's projects, fleets and emulators.
  Applying it makes Fleet Cloud match: what is missing is created, what differs is changed, and
  what already matches is left alone, with its state. A plan says what applying would do and
  does nothing.

  Rule: The first apply creates everything the file declares

    Background:
      Given Ada's repository holds this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        name: Acme
        projects:
          web:
            name: Web app
            fleets:
              <acme-staging>:
                name: Staging
                services:
                  stripe: { durability: strict }
                  resend: {}
                  mail: { target: resend }
          docs: {}
        """

    Scenario: The organization, its projects, fleets and emulators are created
      When she applies it
      Then the file is reported as applied
      And the changes reported are:
        | change | kind         | name                | detail           |
        | create | organization | acme                |                  |
        | create | project      | web                 |                  |
        | create | project      | docs                |                  |
        | create | fleet        | acme-staging        |                  |
        | create | emulator     | acme-staging/stripe | strict           |
        | create | emulator     | acme-staging/resend | buffered         |
        | create | emulator     | acme-staging/mail   | resend, buffered |
      And the organization "acme" is called "Acme"
      And the organization "acme" has exactly these projects and fleets:
        | project | name    | fleets       |
        | web     | Web app | acme-staging |
        | docs    | docs    |              |
      And the fleet "acme-staging" runs stripe, resend and mail

    Scenario: Whoever applies first becomes the organization's owner
      When she applies it
      Then Ada is the owner of the organization "acme"
      And the organization "acme" is managed by the file Ada applied

    Scenario: The emulators answer at their URLs straight away
      When she applies it
      Then a Stripe SDK can create a customer through the "stripe" emulator of "acme-staging"
      When an SDK sends an email through the "mail" emulator of "acme-staging"
      Then the email is accepted

    Scenario: Whatever the file leaves out takes its default
      When she applies it
      Then the fleet "acme-staging" is configured as:
        | name                | Staging                              |
        | project             | web                                  |
        | access              | open                                 |
        | requests per minute | the organization's ceiling           |
        | url                 | https://fleet.example/f/acme-staging |
      And the emulators of "acme-staging" are:
        | name   | target | durability |
        | stripe | stripe | strict     |
        | resend | resend | buffered   |
        | mail   | resend | buffered   |

    Scenario: The file can be sent as JSON instead of YAML
      When she applies it as JSON
      Then the file is reported as applied
      And the fleet "acme-staging" runs stripe, resend and mail

  Rule: Applying the same file again changes nothing

    Background:
      Given Ada has applied this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        projects:
          web:
            fleets:
              <acme-staging>:
                services:
                  resend: { durability: strict }
        """
      And an SDK has sent an email through the "resend" emulator of "acme-staging"

    Scenario: A second apply reports nothing to change
      When she applies it again
      Then the file is reported as applied
      And nothing is reported to change

    Scenario: A second apply keeps what the emulators hold
      When she applies it again
      Then the email can be read back from the "resend" emulator of "acme-staging"
      And object storage holds state for the "resend" emulator of "acme-staging"

  Rule: A plan reports what applying would change, and changes nothing

    Scenario: Planning a new organization creates nothing
      Given Ada's repository holds this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        projects:
          web:
            fleets:
              <acme-staging>:
                services:
                  resend: {}
        """
      When she plans it
      Then the file is reported as planned, not applied
      And the changes reported are:
        | change | kind         | name                | detail   |
        | create | organization | acme                |          |
        | create | project      | web                 |          |
        | create | fleet        | acme-staging        |          |
        | create | emulator     | acme-staging/resend | buffered |
      And Ada belongs to no organizations
      And nothing answers at the URL of the fleet "acme-staging"

    Scenario: Planning a change to an existing organization leaves it as it was
      Given Ada has applied this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        projects:
          web:
            fleets:
              <acme-staging>:
                access: open
                services:
                  resend: {}
        """
      When she changes "access: open" to "access: key" in the file
      And she plans it
      Then the only change reported is:
        | update | fleet | acme-staging | access open → key |
      And the fleet "acme-staging" is configured as:
        | access | open |
      And Fleet Cloud still matches the file that was applied

  Rule: Each change is described in words

    Background:
      Given Ada has applied this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        name: Acme
        projects:
          web:
            name: Web app
            fleets:
              <acme-staging>:
                name: Staging
                access: open
                requestsPerMinute: 600
                services:
                  resend: { durability: strict }
                  mail: { target: resend, seed: "1" }
                  surveys: { target: formbricks, settings: { contactsEnabled: true } }
        """

    Scenario Outline: Changing <what> is reported as an update of the <kind>
      When she changes "<from>" to "<to>" in the file
      And she plans it
      Then the only change reported is:
        | update | <kind> | <name> | <detail> |

      Examples:
        | what                       | from                      | to                        | kind         | name                | detail                                          |
        | the organization's name    | name: Acme                | name: Acme Inc            | organization | acme                | name Acme → Acme Inc                            |
        | a project's name           | name: Web app             | name: Website             | project      | web                 | name Web app → Website                          |
        | a fleet's name             | name: Staging             | name: Preview             | fleet        | acme-staging        | name Staging → Preview                          |
        | a fleet's access           | access: open              | access: key               | fleet        | acme-staging        | access open → key                               |
        | a fleet's request rate     | requestsPerMinute: 600    | requestsPerMinute: 300    | fleet        | acme-staging        | requestsPerMinute 600 → 300                     |
        | a fleet's rate to no limit | requestsPerMinute: 600    | # no rate of its own      | fleet        | acme-staging        | requestsPerMinute 600 → ceiling                 |
        | an emulator's durability   | durability: strict        | durability: ephemeral     | emulator     | acme-staging/resend | durability strict → ephemeral                   |
        | an emulator's seed         | seed: "1"                 | seed: "2"                 | emulator     | acme-staging/mail   | seed 1 → 2                                      |
        | an emulator's settings     | contactsEnabled: true     | contactsEnabled: false    | emulator     | acme-staging/surveys | settings                                       |
        | what an emulator emulates  | mail: { target: resend    | mail: { target: stripe    | emulator     | acme-staging/mail   | target resend → stripe; its state is reset      |

    Scenario: Several changes are reported together, in the order of the file
      When she changes the file to:
        """
        version: 1
        organization: <acme>
        name: Acme Inc
        projects:
          web:
            name: Web app
            fleets:
              <acme-staging>:
                name: Staging
                access: key
                requestsPerMinute: 600
                services:
                  resend: { durability: buffered }
                  mail: { target: resend, seed: "1" }
                  surveys: { target: formbricks, settings: { contactsEnabled: true } }
                  billing: { target: stripe }
          api:
            fleets:
              <acme-api>:
                services:
                  resend: {}
        """
      And she plans it
      Then the changes reported are:
        | change | kind         | name                 | detail                       |
        | update | organization | acme                 | name Acme → Acme Inc         |
        | create | project      | api                  |                              |
        | update | fleet        | acme-staging         | access open → key            |
        | update | emulator     | acme-staging/resend  | durability strict → buffered |
        | create | emulator     | acme-staging/billing | stripe, buffered             |
        | create | fleet        | acme-api             |                              |
        | create | emulator     | acme-api/resend      | buffered                     |

  Rule: Fleet Cloud follows the file

    Background:
      Given Ada has applied this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        name: Acme
        projects:
          web:
            name: Web app
            fleets:
              <acme-staging>:
                name: Staging
                access: open
                services:
                  resend: { durability: strict }
                  billing: { target: stripe, durability: strict }
        """

    Scenario: Names, access and the request rate follow the file
      When she changes the file to:
        """
        version: 1
        organization: <acme>
        name: Acme Inc
        projects:
          web:
            name: Website
            fleets:
              <acme-staging>:
                name: Preview
                access: key
                requestsPerMinute: 300
                services:
                  resend: { durability: strict }
                  billing: { target: stripe, durability: strict }
        """
      And she applies it
      Then the organization "acme" is called "Acme Inc"
      And the organization "acme" has exactly these projects and fleets:
        | project | name    | fleets       |
        | web     | Website | acme-staging |
      And the fleet "acme-staging" is configured as:
        | name                | Preview |
        | access              | key     |
        | requests per minute | 300     |

    Scenario: A fleet that needs a key after an apply refuses callers without one
      When she changes "access: open" to "access: key" in the file
      And she applies it
      And an SDK sends an email through the "resend" emulator of "acme-staging"
      Then the response status is 401

    Scenario: Durability, seed and settings follow the file
      When she changes the file to:
        """
        version: 1
        organization: <acme>
        projects:
          web:
            fleets:
              <acme-staging>:
                services:
                  resend: { durability: ephemeral, seed: "42" }
                  billing:
                    target: formbricks
                    durability: buffered
                    flushIntervalMs: 500
                    settings: { contactsEnabled: true }
        """
      And she applies it
      Then the emulators of "acme-staging" are:
        | name    | target     | durability | seed | flushIntervalMs | settings                 |
        | resend  | resend     | ephemeral  | 42   |                 | {}                       |
        | billing | formbricks | buffered   |      | 500             | {"contactsEnabled":true} |

    Scenario: Leaving a name out of the file keeps the name it has
      When she removes the line "name: Staging" from the file
      And she removes the line "name: Acme" from the file
      And she applies it
      Then nothing is reported to change
      And the organization "acme" is called "Acme"
      And the fleet "acme-staging" is configured as:
        | name | Staging |

    Scenario: Leaving access out of the file opens the fleet again
      Given she changes "access: open" to "access: key" in the file
      And she has applied it
      When she removes the line "access: key" from the file
      And she applies it
      Then the only change reported is:
        | update | fleet | acme-staging | access key → open |

    Scenario: An emulator added to the file starts beside the ones already running
      Given an SDK has sent an email through the "resend" emulator of "acme-staging"
      When she adds under "services:" in the file:
        """
        mail: { target: resend }
        """
      And she applies it
      Then the only change reported is:
        | create | emulator | acme-staging/mail | resend, buffered |
      And the fleet "acme-staging" runs resend, billing and mail
      And the email can be read back from the "resend" emulator of "acme-staging"
      And the email cannot be read back from the "mail" emulator of "acme-staging"

  Rule: A fleet moved to another project in the file moves

    Background:
      Given Ada has applied this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        projects:
          web:
            fleets:
              <acme-staging>:
                services:
                  resend: { durability: strict }
          api: {}
        """
      And an SDK has sent an email through the "resend" emulator of "acme-staging"
      And she changes the file to:
        """
        version: 1
        organization: <acme>
        projects:
          web: {}
          api:
            fleets:
              <acme-staging>:
                services:
                  resend: { durability: strict }
        """

    Scenario: The move is planned as an update of the fleet
      When she plans it
      Then the only change reported is:
        | update | fleet | acme-staging | project → api |

    Scenario: The fleet moves, keeping its URL and its state
      When she applies it
      Then the organization "acme" has exactly these projects and fleets:
        | project | name | fleets       |
        | web     | web  |              |
        | api     | api  | acme-staging |
      And the fleet "acme-staging" is configured as:
        | project | api                                  |
        | url     | https://fleet.example/f/acme-staging |
      And the email can be read back from the "resend" emulator of "acme-staging"

  Rule: State is kept across applies unless an emulator becomes a different emulator

    Background:
      Given Ada has applied this mockingbird.yaml:
        """
        version: 1
        organization: <acme>
        projects:
          web:
            fleets:
              <acme-staging>:
                services:
                  resend: { durability: strict }
                  mail: { target: resend, durability: strict }
                  news: { target: resend, durability: buffered }
        """

    Scenario: An emulator whose target changes starts clean, and the others keep their state
      Given an SDK has sent an email through the "mail" emulator of "acme-staging"
      And an SDK has sent an email through the "resend" emulator of "acme-staging"
      When she changes "mail: { target: resend" to "mail: { target: stripe" in the file
      And she applies it
      Then the only change reported is:
        | update | emulator | acme-staging/mail | target resend → stripe; its state is reset |
      And a Stripe SDK can create a customer through the "mail" emulator of "acme-staging"
      And the "mail" emulator of "acme-staging" kept nothing from before
      And the email can be read back from the "resend" emulator of "acme-staging"

    Scenario Outline: Changing durability from <before> to <after> keeps the emulator's state
      Given an SDK has sent an email through the "<emulator>" emulator of "acme-staging"
      When she changes "<emulator>: { target: resend, durability: <before>" to "<emulator>: { target: resend, durability: <after>" in the file
      And she applies it
      Then the only change reported is:
        | update | emulator | acme-staging/<emulator> | durability <before> → <after> |
      And the email can be read back from the "<emulator>" emulator of "acme-staging"

      Examples:
        | emulator | before   | after     |
        | mail     | strict   | buffered  |
        | mail     | strict   | ephemeral |
        | news     | buffered | strict    |
        | news     | buffered | ephemeral |
