@fleets @limits @quotas
Feature: Quotas per organization
  The operator of the service bounds what one organization may hold: projects, fleets,
  emulators per fleet, members, API keys, stored state per emulator and emulator requests per
  month. Going past a quota is refused with an error that names the quota, so the caller knows
  what to delete or what to ask the operator to raise. A quota of 0 means unlimited.

  Rule: Growth past a quota is refused, naming the quota

    Background:
      Given the server is configured with:
        | LIMIT_ORGS_PER_USER       | 1 |
        | LIMIT_PROJECTS_PER_ORG    | 1 |
        | LIMIT_FLEETS_PER_ORG      | 1 |
        | LIMIT_EMULATORS_PER_FLEET | 1 |
        | LIMIT_API_KEYS_PER_ORG    | 1 |
        | LIMIT_MEMBERS_PER_ORG     | 2 |
      And Ada has an open fleet "Staging" with a strict Resend emulator

    Scenario Outline: Ada cannot <growth>
      When Ada tries to <growth>
      Then the response status is 403
      And the request is refused as "quota_exceeded"
      And the refusal names the quota "<quota>"

      Examples:
        | growth                                       | quota             |
        | create a second organization                 | orgsPerUser       |
        | create a second project                      | projectsPerOrg    |
        | create a second fleet                        | fleetsPerOrg      |
        | add a second emulator to "Staging"           | emulatorsPerFleet |
        | create a second API key                      | apiKeysPerOrg     |
        | invite a second person while one is invited  | membersPerOrg     |

    Scenario: Replacing an existing emulator is not growth
      When Ada replaces the "resend" emulator of "Staging" with a Resend emulator
      Then the request succeeds

    Scenario: Deleting makes room again
      When Ada deletes the fleet "Staging"
      And Ada tries to create a second fleet
      Then the request succeeds

    Scenario: Usage reports each quota and how much of it is used
      When Ada looks at her organization's usage
      Then the usage report shows these limits:
        | projectsPerOrg    | 1 |
        | fleetsPerOrg      | 1 |
        | emulatorsPerFleet | 1 |
        | apiKeysPerOrg     | 1 |
        | membersPerOrg     | 2 |
      And the usage report shows this usage:
        | projects | 1 |
        | fleets   | 1 |
        | members  | 1 |
        | apiKeys  | 0 |

  Rule: A fleet cannot be created with more emulators than one fleet may have

    Scenario: A new fleet with too many emulators is refused
      Given the server is configured with:
        | LIMIT_EMULATORS_PER_FLEET | 1 |
      When Ada tries to create a fleet with two emulators
      Then the response status is 403
      And the request is refused as "quota_exceeded"
      And the refusal names the quota "emulatorsPerFleet"

  Rule: A quota of 0 is unlimited

    Scenario: With no project quota an organization grows past the usual default
      Given the server is configured with:
        | LIMIT_PROJECTS_PER_ORG | 0 |
      When Ada creates 25 projects in her organization
      And Ada looks at her organization's usage
      Then the usage report shows these limits:
        | projectsPerOrg | 0 |
      And the usage report shows this usage:
        | projects | 25 |

    Scenario: With no monthly request quota a fleet keeps serving
      Given the server is configured with:
        | LIMIT_REQUESTS_PER_MONTH | 0 |
      And Ada has an open fleet "Staging" with an ephemeral Resend emulator
      When SDKs send 5 emails through "Staging"
      Then every one of them is accepted

  Rule: Emulator requests are counted per organization, per day, against a monthly quota

    # The count starts again on the 1st of each month (UTC). That rollover needs a clock the
    # specs cannot move, so it is covered by the unit tests in test/limits.test.ts, not here.

    Background:
      Given the server is configured with:
        | LIMIT_REQUESTS_PER_MONTH | 3 |
      And Ada has an open fleet "Staging" with an ephemeral Resend emulator

    Scenario: Usage reports the requests served this month and per day
      When SDKs send 2 emails through "Staging"
      And Ada looks at her organization's usage
      Then the usage report shows 2 emulator requests this month
      And the usage report shows 2 emulator requests today

    Scenario: A fleet stops serving once the organization has used its monthly requests
      When SDKs send 3 emails through "Staging"
      Then every one of them is accepted
      When an SDK sends an email through "Staging"
      Then the response status is 429
      And the request is refused as "quota_exceeded"
      And the refusal names the quota "requestsPerMonth"

    Scenario: The quota is the organization's, shared by all of its fleets
      Given Ada has an open fleet "Preview" with an ephemeral Resend emulator
      When SDKs send 3 emails through "Staging"
      And an SDK sends an email through "Preview"
      Then the request is refused as "quota_exceeded"

    Scenario: Another organization is not affected
      Given Grace has an open fleet "Other" with an ephemeral Resend emulator
      When SDKs send 3 emails through "Staging"
      And an SDK sends an email through "Other"
      Then the email is accepted

    Scenario: Refused requests are not counted, and the control API keeps working
      When SDKs send 3 emails through "Staging"
      And an SDK sends an email through "Staging"
      And Ada looks at her organization's usage
      Then the request succeeds
      And the usage report shows 3 emulator requests this month

  Rule: An emulator's stored state has a size quota

    Background:
      Given the server is configured with:
        | LIMIT_STATE_BYTES | 2000 |

    Scenario: A strict emulator refuses the write that would outgrow the quota and rolls it back
      Given Ada has an open fleet "Staging" with a strict Resend emulator
      And an SDK has sent an email through "Staging"
      When an SDK sends an oversized email through "Staging"
      Then the response status is 507
      And the request is refused as "state_too_large"
      And the refusal names the quota "stateBytes"
      And what is stored for the emulator of "Staging" is within 2000 bytes
      And the email is still there
      And the emulator of "Staging" still accepts a small email

    Scenario: A buffered emulator that outgrows the quota stops serving until it is reset
      Given Ada has an open fleet "Staging" with a buffered Resend emulator
      And the emulator of "Staging" saves buffered changes every 100 ms
      When an SDK sends an oversized email through "Staging"
      Then the email is accepted
      And within 10 seconds the emulator of "Staging" refuses calls as "state_too_large"
      And object storage holds nothing for "Staging"
      When Ada resets the emulator of "Staging"
      Then the emulator of "Staging" still accepts a small email

    Scenario: A blocked emulator cannot be saved on demand either
      Given Ada has an open fleet "Staging" with a buffered Resend emulator
      And the emulator of "Staging" saves buffered changes every 60000 ms
      And an SDK has sent an oversized email through "Staging"
      When Ada asks the emulator of "Staging" to save its state now
      Then the response status is 503
      And the request is refused as "flush_failed"
